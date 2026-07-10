#!/usr/bin/env node
'use strict';
// stillos-kya CLI: `stillos-kya mcp` runs the MCP stdio server; `stillos-kya check <name> [wallet]`
// runs a one-off Know-Your-Agent screen.
const args = process.argv.slice(2);
if (args[0] === 'mcp') { require('./mcp.cjs'); return; }
if (args[0] === 'check') {
  const { kya } = require('./index.cjs');
  kya({ name: args[1], wallet: args[2] }, { agent: 'cli' }).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.blocked ? 1 : 0);
  }).catch(e => { console.error('ERROR:', e.message); process.exit(2); });
} else {
  console.log('stillos-kya — Know Your Agent\n');
  console.log('  stillos-kya mcp                 run as an MCP stdio server (for agents/clients)');
  console.log('  stillos-kya check <name> [wallet]   one-off counterparty screen\n');
  console.log('verdicts: CLEAR | REVIEW | BLOCK');
  process.exit(2);
}
