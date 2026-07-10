# stillos-kya — Know Your Agent

**The trust toll for agent-to-agent commerce.** Before your AI agent pays another agent, run one check: is the counterparty sanctioned? Is its wallet a scam/contract/drained? StillOS returns a fail-closed **CLEAR / REVIEW / BLOCK** verdict — OFAC SDN screen + live on-chain wallet signals — with an **Ed25519-signed receipt** you can attach to the transaction as proof-of-diligence.

> a16z (Big Ideas 2026) calls "Know Your Agent" — signed agent credentials + counterparty trust — the prerequisite for merchants to let agents onto payment rails. This is a working drop-in for it.

## Install
```bash
npm install stillos-kya
```

## Use — one call
```js
const { kya } = require('stillos-kya');

const r = await kya({ name: 'Acme Agent', wallet: '0xabc...' });
if (!r.allowed) throw new Error(`counterparty ${r.verdict}`); // CLEAR | REVIEW | BLOCK
// r.receipt -> { hash, signature, verify }  (signed, verifiable proof-of-screening)
```

## Use — gate an x402 / express route in one line
```js
const { kyaGate } = require('stillos-kya');

// Every payment through this route runs a counterparty trust-check first.
app.post('/pay-agent', kyaGate({ blockOnReview: false }), async (req, res) => {
  // req.kya = { verdict, allowed, checks, receipt, ... }
  // ...proceed to pay; blocked counterparties never reach here
});
```

## Tiers
- **Free:** unsigned verdict — the answer, for triage.
- **Paid (x402 / API key):** the **signed, independently-verifiable receipt** — the proof-of-diligence that matters in a dispute. Pass `xPayment` or `apiKey` in opts.

Pricing + full endpoint reference: https://nolawealthfinancial.com/notary

## Why signed matters
An unsigned "looks fine" is worthless if a counterparty later turns out sanctioned or fraudulent. A StillOS signed receipt is cryptographic proof that you screened *before* you paid — the audit artifact that protects you.
