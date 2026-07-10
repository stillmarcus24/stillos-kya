'use strict';
/*
 * stillos-kya — Know Your Agent. The trust toll for agent-to-agent commerce.
 *
 * a16z (Big Ideas 2026) named "Know Your Agent" — cryptographically signed agent
 * credentials + counterparty trust — as THE prerequisite for merchants to let AI
 * agents onto payment rails. This is the drop-in for it: one call returns a
 * StillOS CLEAR / REVIEW / BLOCK verdict on a counterparty (OFAC SDN screen +
 * live on-chain wallet signals), fail-closed, with an Ed25519-signed receipt on
 * the paid tier. Gate any transaction on it; every check is a toll through StillOS.
 *
 *   const { kya, kyaGate } = require('stillos-kya');
 *   const r = await kya({ name: 'Acme Agent', wallet: '0x...' });
 *   if (!r.allowed) throw new Error('counterparty not cleared: ' + r.verdict);
 *
 *   // or gate an express route in one line:
 *   app.post('/pay', kyaGate({ blockOnReview: false }), handler);
 *
 * Zero dependencies. Endpoint + payment configurable.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_ENDPOINT = process.env.STILLOS_KYA_ENDPOINT || 'https://nolawealthfinancial.com/notary/agent-clearance';

function postJson(endpoint, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(endpoint); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = JSON.stringify(body);
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad response: ' + b.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 8000, () => { req.destroy(new Error('KYA timeout')); });
    req.end(data);
  });
}

/**
 * kya(counterparty, opts) -> { verdict, allowed, review, blocked, checks, receipt, raw }
 * counterparty: string (name) | { name?, wallet? }
 * opts: { agent?, endpoint?, apiKey?, xPayment?, timeoutMs? }
 *   - apiKey / xPayment: use the paid tier to get a SIGNED, verifiable receipt.
 */
async function kya(counterparty, opts = {}) {
  const cp = typeof counterparty === 'string'
    ? { counterparty_name: counterparty }
    : { counterparty_name: counterparty.name, counterparty_wallet: counterparty.wallet };
  const payload = { agent: opts.agent || 'stillos-kya-client', ...cp };
  const headers = {};
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
  if (opts.xPayment) headers['X-PAYMENT'] = opts.xPayment;
  const res = await postJson(opts.endpoint || DEFAULT_ENDPOINT, payload, headers, opts.timeoutMs);
  const verdict = res.verdict || 'UNKNOWN';
  return {
    verdict,
    allowed: verdict === 'CLEAR',
    review: verdict === 'REVIEW',
    blocked: verdict === 'BLOCK',
    checks: res.checks || null,
    signed: !!res.signature,
    receipt: res.receipt_hash ? { hash: res.receipt_hash, signature: res.signature, verify: res.verify } : null,
    toll: Array.isArray(res.accepts) && res.accepts[0] ? { amount_usd: res.accepts[0].maxAmountRequired / 1e6, network: res.accepts[0].network } : null,
    raw: res,
  };
}

/**
 * kyaGate(opts) -> express middleware. Runs KYA on the request's counterparty and
 * blocks BLOCK (and optionally REVIEW). Attaches result to req.kya.
 * opts.extract(req) -> { name?, wallet? }  (default: reads req.body.counterparty_*)
 * opts.blockOnReview (default false), opts.failOpen (default false)
 */
function kyaGate(opts = {}) {
  return async function (req, res, next) {
    try {
      const cp = opts.extract ? opts.extract(req)
        : { name: req.body && (req.body.counterparty_name || req.body.counterparty), wallet: req.body && (req.body.counterparty_wallet || req.body.wallet) };
      const result = await kya(cp, opts);
      req.kya = result;
      if (result.blocked) return res.status(403).json({ error: 'KYA: counterparty BLOCKED', kya: result });
      if (result.review && opts.blockOnReview) return res.status(403).json({ error: 'KYA: counterparty needs REVIEW', kya: result });
      next();
    } catch (e) {
      if (opts.failOpen) return next();
      res.status(502).json({ error: 'KYA check failed (fail-closed)', detail: String(e && e.message) });
    }
  };
}

module.exports = { kya, kyaGate, DEFAULT_ENDPOINT };
