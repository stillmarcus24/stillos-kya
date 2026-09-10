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

### What the gate lets through (0.4.2)

`kyaGate` requires a **positive** clearance. It does not merely block `BLOCK`.

| Endpoint returns | `req.kya.verdict` | Gate |
|---|---|---|
| `{"verdict":"CLEAR"}` | `CLEAR` | passes to your handler |
| `{"verdict":"REVIEW"}` | `REVIEW` | passes, unless `blockOnReview: true` -> 403 |
| `{"verdict":"BLOCK"}` | `BLOCK` | 403 |
| 402 / 4xx / 5xx / network failure | — | 502, fail-closed |
| **200 with no recognized verdict** (`{}`, `{"verdict":null}`, `{"verdict":"UNKNOWN"}`) | `UNKNOWN` | **502, fail-closed** |

That last row changed in 0.4.2. Through 0.4.1 the gate asked "is this `BLOCK`?" rather
than "is this `CLEAR`?", so any 200 carrying no verdict it recognised fell through to
your handler with `blocked: false`. `allowed` was already computed correctly and simply
never consulted. If you were relying on that behaviour, `kyaGate({ failOpen: true })`
restores it explicitly — as an opt-in, which is the only form it should ever have had.

`0.4.2` also stops the MCP server minting a new agent id on every single call. Set
`STILLOS_KYA_AGENT` for a durable identity across restarts; otherwise one id is minted
per process. The free tier meters per source IP, so this never affected quota — it
affected whether your repeat usage was legible as repeat usage.

## Tiers
- **Free:** 2 checks/agent id/day — unsigned verdict, the answer, for triage.
- **Paid ($0.25 USDC via x402, or an API key):** the **signed, independently-verifiable receipt** — the proof-of-diligence that matters in a dispute.

Pricing + full endpoint reference: https://stillosdigitalholdings.com/notary

## Past the free tier

**Payment support is already installed.** `x402-fetch` and `viem` ship as
`optionalDependencies`, so `npm install stillos-kya` installs them for you. There is no
second install step. Check it yourself:

```js
const { paymentCapability } = require('stillos-kya');
paymentCapability(); // { available: true, deps: { 'x402-fetch': true, viem: true }, reason: null }
```

### Paying — pass a signer, not a secret

Preferred, in order. StillOS never receives, stores, or logs your key in any of them:

```js
// BEST — you own the whole payment transport. This package never touches a key or signer.
const { wrapFetchWithPayment } = require('x402-fetch');
const payingFetch = wrapFetchWithPayment(fetch, myAccount, 500000n); // 500000 = $0.50 USDC
const r = await kya({ name: 'Acme Agent' }, { fetch: payingFetch });

// GOOD — hand us a signer object; the key stays inside it.
const r = await kya({ name: 'Acme Agent' }, { account: myViemAccount, maxUsd: 0.5 });

// LEGACY — a raw hex private key. Still supported, deliberately last. A raw key in an
// env var is the weakest of these: anything that can read your process env can spend it.
const r = await kya({ name: 'Acme Agent' }, { wallet: process.env.MY_WALLET_KEY });
```

On a 402 the SDK pays and retries **exactly once** (`MAX_PAYMENT_RETRIES === 1`). It
refuses to sign for a network, asset, or scheme it does not recognise rather than
trusting the challenge blindly.

### Agent-readable recovery

With no payment capability configured, `kya()` throws a `KyaHttpError` carrying
everything an autonomous caller needs to act — branch on `err.code`, never on message
text:

```js
const { kya, KyaHttpError, CODES } = require('stillos-kya');
try {
  await kya({ name: 'Acme Agent' });
} catch (e) {
  if (e instanceof KyaHttpError && e.code === CODES.PAYMENT_REQUIRED) {
    e.payment;      // { mechanism:'x402', scheme, network, asset, asset_name,
                    //   pay_to, amount_usd, amount_base_units, resource, max_timeout_seconds }
    e.remediation;  // { action:'configure_payment_capability', accepted:[...],
                    //   free_tier_alternative: '...' }
  }
}
```

Codes: `PAYMENT_REQUIRED` · `PAYMENT_CAPABILITY_MISSING` · `PAYMENT_CONSTRUCTION_FAILED` ·
`PAYMENT_REJECTED` · `PAYMENT_UNSUPPORTED` · `BAD_402` · `BAD_REQUEST` · `SERVER_ERROR`.

### Security

**StillOS never asks for, receives, transmits, or stores your private key.** Payment is
signed entirely on your side and reaches us only as a standard x402 `X-PAYMENT`
authorization header. Your own wallet pays your own request.

Key material is never placed in an error message, a log line, or telemetry — including
when a malformed key fails to parse, where the underlying library's own error text is
deliberately suppressed rather than re-thrown.

`STILLOS_KYA_WALLET_KEY` remains supported for the CLI and for backward compatibility.
It is a legacy convenience, not the recommended architecture: prefer `fetch` or
`account` in code.

CLI: `STILLOS_KYA_WALLET_KEY=0x... stillos-kya check "Acme Agent"`

## Why signed matters
An unsigned "looks fine" is worthless if a counterparty later turns out sanctioned or fraudulent. A StillOS signed receipt is cryptographic proof that you screened *before* you paid — the audit artifact that protects you.
