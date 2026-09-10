'use strict';
/*
 * MCP stdio server for stillos-kya — Know Your Agent.
 * Newline-delimited JSON-RPC 2.0, zero external deps. Exposes one tool: kya_check,
 * a fail-closed CLEAR / REVIEW / BLOCK verdict on a counterparty agent (OFAC SDN
 * screen + live on-chain wallet signals) with an optional signed receipt.
 *
 * Run:  npx stillos-kya mcp   (or)   node mcp.cjs
 */
const { kya } = require('./index.cjs');

const SERVER = { name: 'stillos-kya', version: '0.1.0' };
const PROTOCOL = '2024-11-05';

// 2026-09-10: was `'mcp-kya-' + Math.random()...` inline on every tools/call, so each
// invocation arrived as a brand-new agent. Audited against the server: the free tier
// meters on SOURCE IP (notary meterToday(), sybil fix 2026-07-12), so this never
// bought extra free calls -- but it did make repeat usage from one real installer
// unreadable, which is exactly the signal the conversion telemetry exists to capture.
// One stable id per process, same shape as index.cjs's DEFAULT_AGENT. Override with
// STILLOS_KYA_AGENT to get a durable identity across restarts.
const AGENT_ID = process.env.STILLOS_KYA_AGENT || `mcp-kya-${Math.random().toString(36).slice(2, 8)}`;

const TOOLS = [{
  name: 'kya_check',
  description: 'Know Your Agent (KYA): screen a counterparty agent BEFORE paying it. Returns a fail-closed verdict — CLEAR, REVIEW, or BLOCK — from an OFAC SDN sanctions screen plus live on-chain wallet signals, with an Ed25519-signed proof-of-diligence receipt on the paid tier. Call this before any agent-to-agent payment.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Counterparty legal/display name to sanctions-screen (optional)' },
      wallet: { type: 'string', description: 'Counterparty EVM wallet address for on-chain risk signals (optional)' },
    },
    additionalProperties: false,
  },
}];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    if (name !== 'kya_check') return fail(id, -32601, `unknown tool: ${name}`);
    try {
      const r = await kya({ name: args.name, wallet: args.wallet }, { agent: AGENT_ID });
      // 2026-09-10: this used to render EVERY non-BLOCK, non-REVIEW verdict as
      // "— cleared", so an UNKNOWN (or any unrecognized string) was reported to the
      // calling model as `UNKNOWN — cleared`. The one word an agent reads before
      // deciding to send money said the opposite of the truth. Only a positive CLEAR
      // is clearance now; anything else says so and sets isError.
      const cleared = r.allowed === true;
      const summary = `${r.verdict}${
        r.blocked ? ' — DO NOT PAY'
        : r.review ? ' — review before paying'
        : cleared ? ' — cleared'
        : ' — NOT CLEARED, no positive verdict — DO NOT PAY'}`;
      return reply(id, { content: [{ type: 'text', text: summary + '\n' + JSON.stringify(r, null, 2) }], isError: r.blocked || !(cleared || r.review) });
    } catch (e) { return fail(id, -32603, 'kya check failed (fail-closed): ' + (e && e.message)); }
  }
  if (id !== undefined) fail(id, -32601, `unknown method: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(() => {});
  }
});
