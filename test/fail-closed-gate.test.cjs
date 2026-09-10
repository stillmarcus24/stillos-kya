'use strict';
/*
 * Regression: kyaGate must require a POSITIVE clearance, not merely the absence of BLOCK.
 *
 * The 2026-08-24 fix closed the 402 path (any non-2xx now throws, and kyaGate's catch
 * fails closed). It did not close this one: the gate branched on `result.blocked`, so a
 * 200 carrying no verdict it recognised -- {}, {verdict:null}, {verdict:'UNKNOWN'},
 * {verdict:'BANANA'} -- produced blocked:false and called next(). Four of nine response
 * shapes admitted an unscreened counterparty into a payment path.
 *
 * Local mock server only. No network, no wallet, no settlement.
 */
const http = require('http');
const assert = require('assert');
const { kyaGate } = require('../index.cjs');

const CASES = {
  //                    status, body                                    should the gate pass?
  clear:        [200, JSON.stringify({ verdict: 'CLEAR' }),             true],
  review:       [200, JSON.stringify({ verdict: 'REVIEW' }),            true],
  block:        [200, JSON.stringify({ verdict: 'BLOCK' }),             false],
  emptyBody:    [200, '{}',                                             false],
  unknown:      [200, JSON.stringify({ verdict: 'UNKNOWN' }),           false],
  unrecognised: [200, JSON.stringify({ verdict: 'BANANA' }),            false],
  nullVerdict:  [200, JSON.stringify({ verdict: null }),                false],
  malformed:    [200, 'not json',                                       false],
  paywall:      [402, JSON.stringify({ accepts: [{ maxAmountRequired: 250000, network: 'base', scheme: 'exact' }] }), false],
  serverError:  [500, JSON.stringify({ error: 'boom' }),                false],
  badGateway:   [502, '',                                               false],
};

let MODE = null;
const server = http.createServer((req, res) => {
  const [code, body] = CASES[MODE];
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
});

function runGate(mode, opts = {}) {
  MODE = mode;
  return new Promise(resolve => {
    const mw = kyaGate({ endpoint: `http://127.0.0.1:${server.address().port}/agent-clearance`, timeoutMs: 3000, ...opts });
    const req = { body: { counterparty_name: 'Test Co', counterparty_wallet: '0x' + '1'.repeat(40) } };
    let done = false;
    const res = {
      status(c) { this._c = c; return this; },
      json(o) { if (!done) { done = true; resolve({ passed: false, http: this._c, body: o }); } },
    };
    mw(req, res, () => { if (!done) { done = true; resolve({ passed: true, kya: req.kya }); } });
  });
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  console.log('kyaGate — a counterparty reaches your handler only on a positive CLEAR\n');

  for (const [mode, [, , shouldPass]] of Object.entries(CASES)) {
    const r = await runGate(mode);
    t(`${mode.padEnd(13)} -> ${r.passed ? 'next()' : 'blocked ' + r.http}`, () => {
      assert.strictEqual(r.passed, shouldPass,
        `expected ${shouldPass ? 'pass' : 'block'}, got ${r.passed ? 'pass' : 'block'}`);
    });
  }

  const rev = await runGate('review', { blockOnReview: true });
  t('REVIEW + blockOnReview     -> 403', () => {
    assert.strictEqual(rev.passed, false);
    assert.strictEqual(rev.http, 403);
  });

  const fo = await runGate('unknown', { failOpen: true });
  t('UNKNOWN + failOpen         -> next() (explicit opt-in still honoured)', () => {
    assert.strictEqual(fo.passed, true);
  });

  const cl = await runGate('clear');
  t('CLEAR still exposes req.kya to the handler', () => {
    assert.strictEqual(cl.kya.verdict, 'CLEAR');
    assert.strictEqual(cl.kya.allowed, true);
  });

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
