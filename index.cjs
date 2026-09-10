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
 * Zero required dependencies (native fetch, Node >=18). Endpoint + payment configurable.
 *
 * 2026-08-24: real bug found live via a real installer's traffic (34 rapid POSTs to
 * /agent-clearance, 2026-08-19, all past the 2/day free limit) -- postJson() never
 * checked the HTTP status code, so a 402 payment-challenge body (no `verdict` field)
 * silently became `verdict: 'UNKNOWN', blocked: false` instead of an error. Two real
 * consequences: (1) a caller looping through a real counterparty list had no way to
 * know it had stopped getting real screens after call #2 -- it just kept going;
 * (2) kyaGate()'s documented "fail-closed" promise was actually failing OPEN on this
 * exact path, since 'UNKNOWN' is not 'BLOCK'. Fixed by making a 402 (or any non-2xx)
 * throw a real, typed error -- kyaGate()'s existing catch already fails closed by
 * default, so this one fix closes both bugs at once. Also adds optional auto-pay
 * (see opts.wallet below) so a caller who wants signed receipts past the free tier
 * doesn't have to hand-roll x402 payment-header construction.
 *
 * 2026-09-09: the paid path was advertising a barrier that did not exist. This file,
 * bin.cjs and the README all told users that auto-pay "requires: npm install x402-fetch
 * viem". Both are declared in optionalDependencies, which npm installs BY DEFAULT --
 * verified by packing the tarball and installing it into a clean directory outside the
 * repo: x402-fetch@1.2.0 and viem@2.56.3 were both present and both required
 * successfully with no extra user action. Every installer was being told to do work that
 * npm had already done for them, and told it at the exact moment they hit the paywall.
 * Three real external integrators reached that message; none ever sent a payment.
 *
 * Fixed here by (a) detecting payment capability instead of asserting its absence,
 * (b) making an injected signer/account or a payment-capable fetch the primary
 * integration -- a raw private key is now the documented fallback, not the headline,
 * (c) attaching a machine-readable `payment` descriptor and a `code` to every error so
 * an autonomous caller can act on a 402 without reverse-engineering our response, and
 * (d) bounding payment retries explicitly. StillOS never receives, logs or persists a
 * caller's key, and no secret is ever placed in an error message or telemetry field.
 */
const { version: PKG_VERSION } = require('./package.json');
const UA = `stillos-kya/${PKG_VERSION} (+https://www.npmjs.com/package/stillos-kya)`;

const DEFAULT_ENDPOINT = process.env.STILLOS_KYA_ENDPOINT || 'https://stillosdigitalholdings.com/notary/agent-clearance';
// 2026-07-16: was a fixed literal 'stillos-kya-client' -- the README's own
// documented one-call example never passes opts.agent, so EVERY real installer
// following the docs exactly shared one identity, meaning (a) the notary's
// 2/agent/day free tier was really 2/day globally across every real user
// combined, and (b) real activation was structurally invisible -- no way to
// ever distinguish one real installer from another. Same fix as
// stillos-edge-gate's own DEFAULT_AGENT: mint one random id per process,
// reused for that process's calls, so real repeat usage stays traceable.
const DEFAULT_AGENT = `kya-client-${Math.random().toString(36).slice(2, 8)}`;

// Machine-readable error codes. An autonomous caller should branch on `err.code`, never
// on message text. Each maps to a genuinely different remediation.
const CODES = {
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',                     // 402, and this client cannot pay
  PAYMENT_CAPABILITY_MISSING: 'PAYMENT_CAPABILITY_MISSING', // 402, payment libs unavailable in this runtime
  PAYMENT_CONSTRUCTION_FAILED: 'PAYMENT_CONSTRUCTION_FAILED', // signer/account rejected or could not sign
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',                     // we paid, server refused it
  PAYMENT_UNSUPPORTED: 'PAYMENT_UNSUPPORTED',               // 402 asks for an asset/network/scheme we won't pay
  BAD_402: 'BAD_402',                                       // 402 body malformed / unusable
  BAD_REQUEST: 'BAD_REQUEST',
  SERVER_ERROR: 'SERVER_ERROR',
};

// Only these are auto-payable. An unexpected chain or token is refused rather than
// signed for -- paying an unknown asset on an unknown network is exactly the kind of
// thing an autonomous client must not do on the caller's behalf.
const SUPPORTED_NETWORKS = new Set(['base', 'eip155:8453']);
const SUPPORTED_SCHEMES = new Set(['exact']);

// Turn the server's x402 `accepts[0]` into a flat, stable descriptor. This is what an
// agent needs in order to decide/act; previously it had to reach into `accepts` and know
// that maxAmountRequired is USDC base units.
function paymentDescriptor(accepts) {
  const a = Array.isArray(accepts) && accepts[0] ? accepts[0] : null;
  if (!a) return null;
  const amt = Number(a.maxAmountRequired);
  return {
    mechanism: 'x402',
    scheme: a.scheme || null,
    network: a.network || null,
    asset: a.asset || null,
    asset_name: (a.extra && a.extra.name) || null,
    pay_to: a.payTo || null,
    amount_usd: Number.isFinite(amt) ? amt / 1e6 : null,
    amount_base_units: Number.isFinite(amt) ? String(amt) : null,
    resource: a.resource || null,
    max_timeout_seconds: a.maxTimeoutSeconds || null,
  };
}

// Thrown (not returned) on 402/4xx/5xx -- distinguishes "payment or input required"
// from a real CLEAR/REVIEW/BLOCK verdict. .status/.price/.accepts let a caller
// (or the CLI) show real, actionable next steps instead of a generic error string.
class KyaHttpError extends Error {
  constructor(status, body, opts = {}) {
    const accepts = Array.isArray(body && body.accepts) ? body.accepts : null;
    const price = accepts && accepts[0] ? Number(accepts[0].maxAmountRequired) / 1e6 : null;
    super(status === 402
      ? `payment required${price != null ? ` ($${price} USDC)` : ''} — free-tier limit reached for this agent id today`
      : `KYA request failed (HTTP ${status}): ${(body && (body.error || body.message)) || 'no detail'}`);
    this.name = 'KyaHttpError';
    this.status = status;
    this.paymentRequired = status === 402;
    this.price = price;
    this.accepts = accepts;
    this.raw = body;
    this.code = opts.code || (status === 402 ? CODES.PAYMENT_REQUIRED
      : status >= 500 ? CODES.SERVER_ERROR : CODES.BAD_REQUEST);
    // Everything a payer needs, flat. Present on any 402 regardless of code.
    this.payment = status === 402 ? paymentDescriptor(accepts) : null;
    // Exactly what the caller must do next, machine-readable. No secret ever appears here.
    this.remediation = status === 402 ? {
      action: 'configure_payment_capability',
      accepted: ['opts.fetch (payment-capable fetch)', 'opts.account (viem account / signer)', 'opts.wallet (raw hex key — legacy)'],
      note: 'x402-fetch and viem ship as optionalDependencies and are installed by `npm install stillos-kya`. StillOS never receives your key.',
      free_tier_alternative: 'pass a different opts.agent for a separate daily budget, or wait for the daily reset',
    } : null;
  }
}

async function postJson(endpoint, body, headers, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 8000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('KYA timeout') : e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error('bad response: ' + text.slice(0, 120)); }
  if (!res.ok) throw new KyaHttpError(res.status, json);
  return json;
}

/**
 * paymentCapability() -> { available, reason, deps }
 * Detects whether this runtime can actually construct an x402 payment. Reports the
 * truth rather than asserting a fixed answer -- the previous code assumed the deps were
 * absent and told every user to install them, when npm had already installed both as
 * optionalDependencies. Safe to call at any time; never throws.
 */
function paymentCapability() {
  const deps = {};
  try { require.resolve('x402-fetch'); deps['x402-fetch'] = true; } catch { deps['x402-fetch'] = false; }
  try { require.resolve('viem/accounts'); deps.viem = true; } catch { deps.viem = false; }
  const available = deps['x402-fetch'] && deps.viem;
  return {
    available,
    deps,
    reason: available ? null
      : 'x402-fetch and/or viem could not be resolved in this runtime. They ship as optionalDependencies of stillos-kya; a normal `npm install stillos-kya` installs them. If they are missing, the install may have run with --no-optional or --omit=optional.',
  };
}

// Refuse to auto-sign for a chain/asset/scheme we did not expect. A 402 is untrusted
// input: an agent that blindly signs whatever a server asks for is a liability.
function assertPayable(desc) {
  if (!desc || !desc.pay_to || !desc.amount_base_units) {
    throw new KyaHttpError(402, { accepts: null }, { code: CODES.BAD_402 });
  }
  if (!SUPPORTED_NETWORKS.has(String(desc.network))) {
    const e = new KyaHttpError(402, { accepts: [{}] }, { code: CODES.PAYMENT_UNSUPPORTED });
    e.message = `refusing to auto-pay on unsupported network: ${desc.network}`;
    e.payment = desc;
    throw e;
  }
  if (!SUPPORTED_SCHEMES.has(String(desc.scheme))) {
    const e = new KyaHttpError(402, { accepts: [{}] }, { code: CODES.PAYMENT_UNSUPPORTED });
    e.message = `refusing to auto-pay unsupported scheme: ${desc.scheme}`;
    e.payment = desc;
    throw e;
  }
}

/**
 * Build a payment-capable fetch from whatever the caller supplied, in order of how much
 * we'd rather they used it:
 *   opts.fetch    — caller owns the whole payment transport. StillOS code never touches
 *                   a key or a signer at all. Best option.
 *   opts.account  — a viem account / any signer object. The key stays in the caller's
 *                   object; we only hand it to x402-fetch.
 *   opts.wallet   — legacy: may be a raw hex private key (or an account). Supported for
 *                   backward compatibility, deliberately last.
 * Returns null if the caller supplied no payment capability at all.
 */
function resolvePayingFetch(opts, maxUsd) {
  if (typeof opts.fetch === 'function') return opts.fetch; // fully injected transport
  const signer = opts.account || opts.signer || opts.wallet
    || (process.env.STILLOS_KYA_WALLET_KEY || null);
  if (!signer) return null;

  const cap = paymentCapability();
  if (!cap.available) {
    const e = new KyaHttpError(402, { accepts: null }, { code: CODES.PAYMENT_CAPABILITY_MISSING });
    e.message = cap.reason;
    throw e;
  }
  const { wrapFetchWithPayment } = require('x402-fetch');
  const { privateKeyToAccount } = require('viem/accounts');
  let account;
  try {
    // A raw hex string is the only case where we construct an account ourselves.
    account = typeof signer === 'string' ? privateKeyToAccount(signer) : signer;
  } catch (err) {
    // Deliberately does NOT include err.message: viem echoes the offending key material
    // into its own error text on a malformed key, and that must never surface.
    const e = new KyaHttpError(402, { accepts: null }, { code: CODES.PAYMENT_CONSTRUCTION_FAILED });
    e.message = 'could not construct a signing account from the supplied credential (value withheld)';
    throw e;
  }
  const maxValue = BigInt(Math.round((maxUsd || 0.5) * 1e6)); // USDC has 6 decimals
  return wrapFetchWithPayment(fetch, account, maxValue);
}

// Pay and retry ONCE. x402 is a single challenge/response: one 402, one payment, one
// retry. If the retry 402s again the payment was rejected -- retrying further would
// re-sign and risk paying twice for nothing, so it is a hard stop, not a backoff loop.
const MAX_PAYMENT_RETRIES = 1;

async function payAndRetry(endpoint, body, headers, payingFetch) {
  let res;
  try {
    res = await payingFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const e = new KyaHttpError(402, { accepts: null }, { code: CODES.PAYMENT_CONSTRUCTION_FAILED });
    e.message = `payment could not be constructed or sent: ${String(err && err.message).slice(0, 200)}`;
    throw e;
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error('bad response after payment: ' + text.slice(0, 120)); }
  if (res.status === 402) {
    // We paid and the server still says no. Bounded: we do not try again.
    throw new KyaHttpError(402, json, { code: CODES.PAYMENT_REJECTED });
  }
  if (!res.ok) throw new KyaHttpError(res.status, json);
  return json;
}

/**
 * kya(counterparty, opts) -> { verdict, allowed, review, blocked, checks, receipt, raw }
 * counterparty: string (name) | { name?, wallet? }
 * opts: { agent?, endpoint?, apiKey?, xPayment?, timeoutMs?, fetch?, account?, wallet?, maxUsd? }
 *   - apiKey / xPayment: use the paid tier directly (you already have a valid X-PAYMENT header).
 *   - fetch:   a payment-capable fetch (e.g. x402-fetch's wrapFetchWithPayment(...)).
 *              PREFERRED -- StillOS code never touches your key or your signer.
 *   - account: a viem account / signer object. Your key stays inside your object.
 *   - wallet:  legacy. May be a raw hex private key. Still supported, but a raw key in
 *              an env var is the weakest of the three -- prefer `fetch` or `account`.
 *   - maxUsd:  cap per call when auto-paying (default 0.50).
 * Auto-pay engages on a 402 and retries exactly once (MAX_PAYMENT_RETRIES).
 * Throws KyaHttpError on 402/4xx/5xx instead of returning a fake verdict. Branch on
 * `err.code` (see CODES); `err.payment` carries amount/asset/network/pay_to and
 * `err.remediation` carries the exact configuration action required.
 */
async function kya(counterparty, opts = {}) {
  const cp = typeof counterparty === 'string'
    ? { counterparty_name: counterparty }
    : { counterparty_name: counterparty.name, counterparty_wallet: counterparty.wallet };
  const payload = { agent: opts.agent || DEFAULT_AGENT, ...cp };
  const headers = {};
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
  if (opts.xPayment) headers['X-PAYMENT'] = opts.xPayment;
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;

  let res;
  try {
    res = await postJson(endpoint, payload, headers, opts.timeoutMs);
  } catch (e) {
    if (!(e instanceof KyaHttpError) || !e.paymentRequired) throw e;
    // 402. Can we pay? resolvePayingFetch throws a typed, coded error if the caller
    // supplied a credential we cannot use; it returns null if they supplied none at all.
    const payingFetch = resolvePayingFetch(opts, opts.maxUsd);
    if (!payingFetch) throw e; // code PAYMENT_REQUIRED, with .payment + .remediation attached
    assertPayable(e.payment);  // refuse unknown network/asset/scheme rather than signing blind
    res = await payAndRetry(endpoint, payload, headers, payingFetch);
  }

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
      if (result.review) {
        if (opts.blockOnReview) return res.status(403).json({ error: 'KYA: counterparty needs REVIEW', kya: result });
      } else if (!result.allowed) {
        // 2026-09-10: the second half of the 2026-08-24 fail-open bug, found by a
        // response-shape sweep rather than by live traffic. That fix closed the 402
        // path (non-2xx now throws, and the catch below fails closed). This path was
        // still open: the gate asked "is this BLOCK?" instead of "is this CLEAR?", so
        // ANY 200 whose body carried no recognized verdict -- {} , {verdict:null},
        // {verdict:'UNKNOWN'}, {verdict:'BANANA'} -- produced blocked:false and called
        // next(). A gate that admits everything it does not recognize is not
        // fail-closed, it is fail-open with extra steps. `allowed` was already
        // computed correctly one struct field away and simply never consulted.
        // CLEAR passes. REVIEW passes unless blockOnReview. Everything else stops here.
        if (opts.failOpen) return next();
        return res.status(502).json({
          error: 'KYA: no positive CLEAR verdict (fail-closed)',
          detail: `verdict '${result.verdict}' is not a recognized clearance`,
          kya: result,
        });
      }
      next();
    } catch (e) {
      if (opts.failOpen) return next();
      res.status(502).json({ error: 'KYA check failed (fail-closed)', detail: String(e && e.message) });
    }
  };
}

module.exports = {
  kya, kyaGate, DEFAULT_ENDPOINT, KyaHttpError,
  // Machine-readable error codes -- branch on these, not on message text.
  CODES,
  // Report whether this runtime can construct an x402 payment (never throws).
  paymentCapability,
  // Explicit and bounded: one 402, one payment, one retry. No loop.
  MAX_PAYMENT_RETRIES,
};
