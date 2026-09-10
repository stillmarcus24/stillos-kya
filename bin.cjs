#!/usr/bin/env node
'use strict';
// stillos-kya CLI: `stillos-kya mcp` runs the MCP stdio server; `stillos-kya check <name> [wallet]`
// runs a one-off Know-Your-Agent screen.
function parseFlag(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((a, i) => a !== '--agent' && rawArgs[i - 1] !== '--agent');
if (args[0] === 'mcp') { require('./mcp.cjs'); return; }
if (args[0] === 'check') {
  const { kya, KyaHttpError } = require('./index.cjs');
  // Was a fixed 'cli' literal -- every real CLI user on earth shared one
  // identity and one free-tier budget. Randomized per invocation unless
  // --agent is passed, same convention as stillos-edge-gate's CLI.
  const agent = parseFlag(rawArgs, '--agent') || `kya-cli-${Math.random().toString(36).slice(2, 8)}`;
  // STILLOS_KYA_WALLET_KEY, if set, lets index.cjs auto-pay past the free tier --
  // opt-in only, your own wallet pays your own request, never StillOS's.
  kya({ name: args[1], wallet: args[2] }, { agent }).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.blocked ? 1 : 0);
  }).catch(e => {
    if (e instanceof KyaHttpError && e.paymentRequired) {
      // 2026-09-09: this block used to end with "(requires: npm install x402-fetch
      // viem)". That was false -- both ship as optionalDependencies and npm installs
      // them with the package. It told users to do work already done, at the exact
      // moment they hit the paywall. Now it reports real detected capability instead.
      const cap = require('./index.cjs').paymentCapability();
      const p = e.payment || {};
      console.error(`Free-tier limit reached for this run (2 checks/day per agent id).`);
      console.error(`Next check costs $${e.price ?? '0.25'} ${p.asset_name || 'USDC'} on ${p.network || 'base'} via x402.`);
      if (cap.available) {
        console.error(`Payment support is INSTALLED and ready in this environment.`);
        console.error(`In code, pass a signer you control -- kya(cp, { account: yourViemAccount }) -- or a`);
        console.error(`payment-capable fetch: kya(cp, { fetch: wrapFetchWithPayment(fetch, account, max) }).`);
        console.error(`For this CLI, export STILLOS_KYA_WALLET_KEY=0x... (legacy; a raw key in an env var is`);
        console.error(`the weakest option -- StillOS never receives it either way).`);
      } else {
        console.error(`Payment support is NOT available in this environment: ${cap.reason}`);
      }
      console.error(`Or wait for the daily reset, or pass a fresh --agent name for a separate budget.`);
    } else {
      console.error('ERROR:', e.message);
    }
    process.exit(2);
  });
} else {
  console.log('stillos-kya — Know Your Agent\n');
  console.log('  stillos-kya mcp                 run as an MCP stdio server (for agents/clients)');
  console.log('  stillos-kya check <name> [wallet] [--agent <id>]   one-off counterparty screen\n');
  console.log('verdicts: CLEAR | REVIEW | BLOCK');
  process.exit(2);
}
