#!/usr/bin/env node
'use strict';
/*
 * Payment-funnel tests for stillos-kya.
 *
 * Covers the whole paid journey against a LOCAL mock notary — free request, free-tier
 * exhaustion, the 402, machine-readable remediation, safe no-wallet failure, capability
 * detection, malformed/unsupported 402 refusal, bounded retry, and a simulated paid
 * retry that returns the real product result.
 *
 * No real funds, no mainnet, no network egress: the "payment" is a mock payment-capable
 * fetch injected via opts.fetch, which is exactly the integration path this package now
 * recommends. That injection point is what makes the paid path testable at all without
 * spending money — before it existed, the only way in was a raw private key.
 *
 *   node test/payment-funnel.test.cjs
 */
const http = require('http');
const assert = require('assert');
const { kya, KyaHttpError, CODES, paymentCapability, MAX_PAYMENT_RETRIES } = require('../index.cjs');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(`  PASS  ${name}`); }
  catch (e) { fail++; results.push(`  FAIL  ${name}\n          ${e.message}`); }
}

// ── mock notary: free tier of 2, then a real-shaped x402 402 ──────────────────
const CHALLENGE = (resource) => ({
  error: 'free tier exhausted',
  accepts: [{
    scheme: 'exact', network: 'base', maxAmountRequired: '250000',
    resource, description: 'StillOS notary: agent clearance', mimeType: 'application/json',
    maxTimeoutSeconds: 300, payTo: '0xfAB07d26F7627fc4cE459ecf90d7E015F7eEcE71',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' },
  }],
});
const PRODUCT = { verdict: 'CLEAR', checks: { ofac: 'no_match' }, receipt_hash: 'abc123', signature: 'sig', verify: 'https://x/verify' };

let served = 0, paidHits = 0, freeLimit = 2, mode = 'normal';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const paid = !!req.headers['x-payment'];
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const resource = `http://127.0.0.1:${server.address().port}/agent-clearance`;
    if (paid) {
      paidHits++;
      if (mode === 'always402') return send(402, CHALLENGE(resource)); // server rejects the payment
      return send(200, { ...PRODUCT, tier: 'x402' });
    }
    served++;
    if (served > freeLimit) {
      if (mode === 'malformed402') return send(402, { error: 'pay up' });                       // no accepts
      if (mode === 'badnetwork') { const c = CHALLENGE(resource); c.accepts[0].network = 'solana-mainnet'; return send(402, c); }
      if (mode === 'badscheme') { const c = CHALLENGE(resource); c.accepts[0].scheme = 'streaming'; return send(402, c); }
      return send(402, CHALLENGE(resource));
    }
    send(200, { ...PRODUCT, tier: 'free' });
  });
});

const reset = (m = 'normal') => { served = 0; paidHits = 0; mode = m; };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/agent-clearance`;
  const base = { endpoint, agent: 'test-agent', timeoutMs: 5000 };

  // 1. free request succeeds
  await t('free request succeeds and returns the product verdict', async () => {
    reset();
    const r = await kya({ name: 'Acme' }, base);
    assert.strictEqual(r.verdict, 'CLEAR');
    assert.strictEqual(r.allowed, true);
  });

  // 2 + 3. free allowance exhausted -> 402
  await t('free allowance exhausts and throws a typed 402 (not a fake verdict)', async () => {
    reset();
    await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    await assert.rejects(() => kya({ name: 'c' }, base), (e) => {
      assert.ok(e instanceof KyaHttpError, 'not a KyaHttpError');
      assert.strictEqual(e.status, 402);
      assert.strictEqual(e.paymentRequired, true);
      assert.strictEqual(e.verdict, undefined, 'must not fabricate a verdict');
      return true;
    });
  });

  // 4. 402 is machine-readable
  await t('402 exposes a complete machine-readable payment descriptor', async () => {
    reset(); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    try { await kya({ name: 'c' }, base); assert.fail('should have thrown'); }
    catch (e) {
      assert.strictEqual(e.code, CODES.PAYMENT_REQUIRED);
      const p = e.payment;
      assert.ok(p, 'no payment descriptor');
      assert.strictEqual(p.mechanism, 'x402');
      assert.strictEqual(p.amount_usd, 0.25);
      assert.strictEqual(p.network, 'base');
      assert.strictEqual(p.scheme, 'exact');
      assert.strictEqual(p.pay_to, '0xfAB07d26F7627fc4cE459ecf90d7E015F7eEcE71');
      assert.strictEqual(p.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      assert.strictEqual(p.asset_name, 'USD Coin');
      assert.ok(p.amount_base_units === '250000');
    }
  });

  // 5. no-wallet client fails safely AND actionably
  await t('no-wallet client fails safely with actionable remediation', async () => {
    reset(); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    try { await kya({ name: 'c' }, base); assert.fail('should have thrown'); }
    catch (e) {
      assert.ok(e.remediation, 'no remediation block');
      assert.strictEqual(e.remediation.action, 'configure_payment_capability');
      assert.ok(Array.isArray(e.remediation.accepted) && e.remediation.accepted.length >= 3);
      assert.ok(e.remediation.free_tier_alternative);
      assert.ok(!/npm install x402-fetch viem/.test(JSON.stringify(e.remediation)),
        'must not repeat the false "install the deps" instruction');
    }
  });

  // 6. capability detection reports truth
  await t('paymentCapability() detects installed deps instead of asserting absence', async () => {
    const c = paymentCapability();
    assert.strictEqual(typeof c.available, 'boolean');
    assert.ok(c.deps && 'x402-fetch' in c.deps && 'viem' in c.deps);
    if (c.available) assert.strictEqual(c.reason, null);
  });

  // 7. malformed 402 rejected safely
  await t('malformed 402 (no accepts) is rejected, never signed for', async () => {
    reset('malformed402'); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    const payingFetch = async () => { throw new Error('must not be called'); };
    await assert.rejects(() => kya({ name: 'c' }, { ...base, fetch: payingFetch }),
      (e) => { assert.strictEqual(e.code, CODES.BAD_402); return true; });
    assert.strictEqual(paidHits, 0, 'no payment may be attempted on a malformed challenge');
  });

  // 8. unsupported network / scheme rejected
  await t('unsupported network is refused rather than auto-signed', async () => {
    reset('badnetwork'); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    const payingFetch = async () => { throw new Error('must not be called'); };
    await assert.rejects(() => kya({ name: 'c' }, { ...base, fetch: payingFetch }),
      (e) => { assert.strictEqual(e.code, CODES.PAYMENT_UNSUPPORTED); return true; });
    assert.strictEqual(paidHits, 0);
  });
  await t('unsupported scheme is refused rather than auto-signed', async () => {
    reset('badscheme'); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    const payingFetch = async () => { throw new Error('must not be called'); };
    await assert.rejects(() => kya({ name: 'c' }, { ...base, fetch: payingFetch }),
      (e) => { assert.strictEqual(e.code, CODES.PAYMENT_UNSUPPORTED); return true; });
    assert.strictEqual(paidHits, 0);
  });

  // 9 + 10. server rejects payment -> PAYMENT_REJECTED, bounded, no loop
  await t('rejected payment yields PAYMENT_REJECTED and retries are bounded (no loop)', async () => {
    reset('always402'); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    let calls = 0;
    const payingFetch = async (url, init) => { calls++; return fetch(url, { ...init, headers: { ...init.headers, 'X-PAYMENT': 'mock-authorization' } }); };
    await assert.rejects(() => kya({ name: 'c' }, { ...base, fetch: payingFetch }),
      (e) => { assert.strictEqual(e.code, CODES.PAYMENT_REJECTED); return true; });
    assert.strictEqual(calls, MAX_PAYMENT_RETRIES, `paid exactly ${MAX_PAYMENT_RETRIES}x, got ${calls}`);
    assert.strictEqual(paidHits, 1, 'must not re-sign and pay repeatedly');
  });

  // 11 + 12. successful simulated payment -> retry -> real product result
  await t('payment-capable client pays once and receives the underlying product', async () => {
    reset(); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    let calls = 0;
    const payingFetch = async (url, init) => { calls++; return fetch(url, { ...init, headers: { ...init.headers, 'X-PAYMENT': 'mock-authorization' } }); };
    const r = await kya({ name: 'c' }, { ...base, fetch: payingFetch });
    assert.strictEqual(r.verdict, 'CLEAR', 'did not return the real product result');
    assert.strictEqual(r.allowed, true);
    assert.ok(r.receipt && r.receipt.hash === 'abc123', 'signed receipt missing from paid result');
    assert.strictEqual(calls, 1, 'should pay exactly once');
  });

  // 13. no secret ever surfaces
  await t('no secret appears in error text, telemetry, or the payment descriptor', async () => {
    const SECRET = '0x' + 'ab'.repeat(32);
    reset(); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    let leaked = null;
    try {
      // Deliberately malformed key -> viem throws, and its error text echoes key material.
      await kya({ name: 'c' }, { ...base, wallet: '0xnot-a-real-key' });
    } catch (e) {
      const blob = JSON.stringify({ m: e.message, s: e.stack, p: e.payment, r: e.remediation, raw: e.raw });
      if (blob.includes('0xnot-a-real-key')) leaked = 'malformed key echoed';
    }
    assert.strictEqual(leaked, null, `secret leaked: ${leaked}`);
    // And a valid-looking key must never appear either.
    reset(); await kya({ name: 'a' }, base); await kya({ name: 'b' }, base);
    try { await kya({ name: 'c' }, { ...base, wallet: SECRET, maxUsd: 0.01 }); } catch (e) {
      const blob = JSON.stringify({ m: e.message, s: e.stack, p: e.payment, r: e.remediation });
      assert.ok(!blob.includes(SECRET), 'private key leaked into error surface');
      assert.ok(!blob.includes('ab'.repeat(16)), 'partial key material leaked');
    }
  });

  server.close();
  console.log('\nstillos-kya payment funnel\n');
  results.forEach((r) => console.log(r));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
