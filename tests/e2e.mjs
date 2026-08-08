// End-to-end: CLI contract + MCP protocol
// This suite verifies that "someone else can actually use this", not that
// "the internal function returns the right thing".
// Run: node tests/e2e.mjs

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');

let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const has = (n, hay, needle) =>
  (String(hay).includes(needle) ? ok(n, `contains "${needle}"`) : bad(n, `didn't find "${needle}"`));

const dir = mkdtempSync(join(tmpdir(), 'postledger-e2e-'));
const BOOK = join(dir, 'demo.db');
const env = { ...process.env, POSTLEDGER_BOOK: BOOK, NODE_OPTIONS: '--no-warnings' };

/** Run the CLI, return {code, stdout, stderr} — never throws, because the
 *  exit code itself is what's under test */
function cli(...args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
const j = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

console.log('\n\x1b[1mA. Basic CLI flow (this is the first code block in the README)\x1b[0m');
{
  let r = cli('init', BOOK, '--name', 'Demo Co', '--currency', 'SGD');
  eq('A1 init succeeds', r.code, 0);
  eq('A2 currency is correct', j(r).currency, 'SGD');

  eq('A3 open account Assets:Bank:Checking', cli('account', 'open', 'Assets:Bank:Checking', '--type', 'asset').code, 0);
  eq('A4 open account Income:Sales', cli('account', 'open', 'Income:Sales', '--type', 'income').code, 0);
  eq('A5 open account Expenses:Rent', cli('account', 'open', 'Expenses:Rent', '--type', 'expense').code, 0);

  r = cli('post', '--key', 'demo-1', '--date', '2026-08-08', '--desc', 'Sales revenue',
          '--leg', 'Assets:Bank:Checking debit 5000.00',
          '--leg', 'Income:Sales credit 5000.00',
          '--expect-total', '5000.00');
  eq('A6 post an entry', r.code, 0);
  eq('A7 total is 5000.00', j(r).total, '5000.00');
  eq('A8 first post is not a replay', j(r).replayed, false);

  r = cli('post', '--key', 'demo-1', '--date', '2026-08-08', '--desc', 'Sales revenue',
          '--leg', 'Assets:Bank:Checking debit 5000.00',
          '--leg', 'Income:Sales credit 5000.00',
          '--expect-total', '5000.00');
  eq('A9 same key replays → still exits 0', r.code, 0);
  eq('A10 and marked as replayed', j(r).replayed, true);
  eq('A11 book still has only 1 entry', j(cli('info')).entries, 1);
}

console.log('\n\x1b[1mB. Exit codes are meaningful (scriptable)\x1b[0m');
{
  let r = cli('post', '--key', 'bad-1', '--date', '2026-08-08', '--desc', 'unbalanced',
              '--leg', 'Assets:Bank:Checking debit 100.00',
              '--leg', 'Income:Sales credit 99.00', '--expect-total', '100.00');
  eq('B1 unbalanced debits/credits → exit code 2 (validation failed)', r.code, 2);
  has('B2 stderr has a human-readable error', r.stderr, 'debits');
  has('B3 and gives an accounting diagnosis', r.stderr, 'hint:');
  eq('B4 stdout is still structured, jq-able error output', j(r).error_code, 'UNBALANCED');

  r = cli('post', '--key', 'demo-1', '--date', '2026-08-08', '--desc', 'changed the amount',
          '--leg', 'Assets:Bank:Checking debit 7000.00',
          '--leg', 'Income:Sales credit 7000.00', '--expect-total', '7000.00');
  eq('B5 idempotency conflict → exit code 3', r.code, 3);

  r = cli('post', '--key', 'bad-2', '--date', 'yesterday', '--desc', 'x',
          '--leg', 'Assets:Bank:Checking debit 1.00', '--leg', 'Income:Sales credit 1.00',
          '--expect-total', '1.00');
  eq('B6 invalid date → exit code 2', r.code, 2);

  r = cli('balance', 'Assets:Bank:Checking', '--book', join(dir, 'nope.db'));
  eq('B7 book does not exist → exit code 4', r.code, 4);
}

console.log('\n\x1b[1mC. Unix composability\x1b[0m');
{
  eq('C1 verify passes → exit code 0 (usable in if)', cli('verify').code, 0);

  const tsv = cli('accounts', '--tsv').stdout.trim().split('\n');
  eq('C2 --tsv outputs a header + 3 rows', tsv.length, 4);
  has('C3 and is tab-separated', tsv[0], '\t');

  const table = cli('accounts', '--table').stdout;
  has('C4 --table has a separator line', table, '─');

  const compact = cli('info', '--compact').stdout.trim();
  eq('C5 --compact is a single line', compact.split('\n').length, 1);

  // anchor --line exists precisely so it can be `>>`'d into an anchor log
  const line = cli('anchor', '--line').stdout.trim();
  eq('C6 anchor --line is seq/hash/time in three fields', line.split('\t').length, 3);

  const anchors = join(dir, 'anchors.log');
  writeFileSync(anchors, line + '\n');
  eq('C7 verify-anchors passes', cli('verify-anchors', anchors).code, 0);
}

console.log("\n\x1b[1mD. Revert all of an actor's writes\x1b[0m");
{
  for (let i = 1; i <= 3; i++) {
    cli('post', '--key', `rogue-${i}`, '--date', '2026-08-09', '--desc', `Bogus entry ${i}`,
        '--actor', 'agent:rogue',
        '--leg', 'Expenses:Rent debit 999.00', '--leg', 'Assets:Bank:Checking credit 999.00',
        '--expect-total', '999.00');
  }
  eq('D1 balance after being polluted', j(cli('balance', 'Assets:Bank:Checking')).balance, '2003.00');

  const dry = j(cli('revert-actor', 'agent:rogue', '--key', 'r1', '--reason', 'went rogue', '--dry-run'));
  eq('D2 dry-run reports 3 entries', dry.matched, 3);
  eq('D3 dry-run does not change the book', j(cli('balance', 'Assets:Bank:Checking')).balance, '2003.00');

  const done = j(cli('revert-actor', 'agent:rogue', '--key', 'r1', '--reason', 'went rogue'));
  eq('D4 actually reverts 3 entries', done.reverted, 3);
  eq('D5 balance back to a clean state', j(cli('balance', 'Assets:Bank:Checking')).balance, '5000.00');
  eq('D6 books still balance', j(cli('trial-balance')).balanced, true);
  eq('D7 audit chain intact', cli('verify').code, 0);
}

console.log('\n\x1b[1mE. Document archiving and fingerprint verification\x1b[0m');
{
  const entryId = j(cli('entries', '--limit', '1')).entries[0].entry_id;
  const pdf = join(dir, 'receipt.pdf');
  writeFileSync(pdf, 'ORIGINAL-INVOICE-BYTES');

  const at = j(cli('attach', entryId, pdf, '--kind', 'invoice', '--key', 'doc-1'));
  eq('E1 archiving succeeds', at.ok, true);
  eq('E2 can look up the document from the entry', j(cli('docs', entryId)).count, 1);
  eq('E3 verify passes', cli('verify').code, 0);

  // swap out the archived file — exactly the attack that "storing a sha256
  // but never checking it" would miss
  const stored = join(dir, 'documents', at.rel_path);
  execFileSync('chmod', ['640', stored]);
  writeFileSync(stored, 'SWAPPED-BYTES');
  const r = cli('verify');
  eq('E4 original swapped → verify exits 5', r.code, 5);
  has('E5 and points to the documents check', r.stdout, 'replaced');
}

console.log('\n\x1b[1mF. MCP protocol (actually goes over stdio JSON-RPC)\x1b[0m');
{
  const book2 = join(dir, 'mcp.db');
  execFileSync('node', [CLI, 'init', book2, '--name', 'MCP Co', '--currency', 'SGD'], { env });
  execFileSync('node', [CLI, 'account', 'open', 'Assets:Bank', '--type', 'asset', '--book', book2], { env });
  execFileSync('node', [CLI, 'account', 'open', 'Income:Sales', '--type', 'income', '--book', book2], { env });

  const responses = await new Promise((resolve, reject) => {
    const p = spawn('node', [CLI, 'mcp', '--book', book2], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) { try { out.push(JSON.parse(line)); } catch {} }
      }
      if (out.length >= 5) { p.kill(); resolve(out); }
    });
    p.on('error', reject);
    setTimeout(() => { p.kill(); resolve(out); }, 15000);

    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
           params: { name: 'postledger_chart', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
           params: { name: 'postledger_post_entry', arguments: {
             idempotency_key: 'mcp-1', date: '2026-08-08', description: 'via MCP',
             legs: [{ account: 'Assets:Bank', side: 'debit', amount: '250.00' },
                    { account: 'Income:Sales', side: 'credit', amount: '250.00' }],
             expected_total: '250.00', actor: 'agent:test' } } });
    // deliberate mistake: pass the amount as a JSON number
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
           params: { name: 'postledger_post_entry', arguments: {
             idempotency_key: 'mcp-2', date: '2026-08-08', description: 'float',
             legs: [{ account: 'Assets:Bank', side: 'debit', amount: 250.0 },
                    { account: 'Income:Sales', side: 'credit', amount: 250.0 }],
             expected_total: '250.00' } } });
  });

  const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
  eq('F1 initialize returns serverInfo', byId[1]?.result?.serverInfo?.name, 'postledger');
  has('F2 instructions tell the model to read the chart of accounts first', byId[1]?.result?.instructions ?? '', 'postledger_chart');

  const tools = byId[2]?.result?.tools ?? [];
  eq('F3 tool list is non-empty', tools.length > 0, true);
  eq('F4 postledger_post_entry exists', tools.some((t) => t.name === 'postledger_post_entry'), true);
  const postTool = tools.find((t) => t.name === 'postledger_post_entry');
  eq('F5 and idempotency_key is required', postTool?.inputSchema?.required?.includes('idempotency_key'), true);
  eq('F6 expected_total is also required', postTool?.inputSchema?.required?.includes('expected_total'), true);
  eq('F7 read-only tools have readOnlyHint', tools.find((t) => t.name === 'postledger_chart')?.annotations?.readOnlyHint, true);

  has('F8 postledger_chart returns the chart of accounts', byId[3]?.result?.content?.[0]?.text ?? '', 'Assets:Bank');

  const posted = JSON.parse(byId[4]?.result?.content?.[0]?.text ?? '{}');
  eq('F9 posting via MCP succeeds', posted.ok, true);
  eq('F10 returns a chain head (lands in the conversation transcript as a witness)', typeof posted.chain_head, 'string');

  eq('F11 passing a JSON number → isError', byId[5]?.result?.isError, true);
  const errPayload = JSON.parse(byId[5]?.result?.content?.[0]?.text ?? '{}');
  eq('F12 error code is BAD_AMOUNT', errPayload.error_code, 'BAD_AMOUNT');
  has('F13 and hint teaches the model how to fix it', errPayload.hint, 'decimal strings');
}

console.log('\n\x1b[1mG. Web view (read-only, localhost-bound)\x1b[0m');
{
  const { spawn } = await import('node:child_process');
  const port = 7801;
  const srv = spawn('node', [CLI, 'serve', '--book', BOOK, '--port', String(port)],
                    { env, stdio: ['ignore', 'pipe', 'pipe'] });

  // Poll until it answers rather than sleeping a fixed amount. A constant is
  // a guess about how fast the machine is, and it was wrong the first time it
  // met an emulated arm64 runner: 1.8s is plenty here and not nearly enough
  // under QEMU. Polling costs nothing when startup is fast.
  const ready = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { await fetch(`http://127.0.0.1:${port}/api/summary`); return true; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    return false;
  })();
  eq('G0 the server came up', ready, true);
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return {
      status: res.status,
      ct: res.headers.get('content-type') ?? '',
      // CSP lives in a header, not in the markup — assert it where it actually is
      csp: res.headers.get('content-security-policy') ?? '',
      body: await res.text(),
    };
  };
  try {
    const page = await get('/');
    eq('G1 the page is served', page.status, 200);
    has('G2 as HTML', page.ct, 'text/html');
    has('G3 with a CSP that blocks every external origin', page.csp, "default-src 'none'");
    eq('G4 nothing is fetched from a CDN', /src="https?:/.test(page.body), false);

    for (const p of ['summary', 'trial-balance', 'balance-sheet', 'income-statement', 'verify', 'audit']) {
      const r = await get(`/api/${p}`);
      eq(`G5.${p} responds`, r.status, 200);
    }

    // The whole point: this surface cannot write.
    const post = await fetch(`http://127.0.0.1:${port}/api/summary`, { method: 'POST' });
    eq('G6 POST is refused', post.status, 405);
    has('G7 and says why', await post.text(), 'read-only');

    const notFound = await get('/api/nope');
    eq('G8 unknown endpoint 404s', notFound.status, 404);
  } finally {
    srv.kill();
  }
}

console.log('\n\x1b[1mH. Single-file HTML audit report\x1b[0m');
{
  const html = cli('export', '--format', 'html').stdout;
  eq('H1 report is produced', html.length > 5000, true);
  has('H2 it is a complete document', html, '<!doctype html>');
  has('H3 data is inlined, not fetched', html, '__POSTLEDGER_SNAPSHOT__');
  has('H4 the chain head is stated up front', html, 'Chain head');
  has('H5 it says it is a snapshot, not a live view', html, 'static snapshot, not a live view');
  has('H6 and tells the reader how to check it', html, 'postledger verify');

  // The whole point of a single file: it must not reach the network.
  eq('H7 no external stylesheets or scripts', /(?:src|href)="https?:/.test(html), false);
  eq('H8 no fetch() to a remote origin', /fetch\(['"`]https?:/.test(html), false);

  const bad = cli('export', '--format', 'nope');
  eq('H9 unknown format is refused', bad.code, 1);
  has('H10 and lists the valid ones', bad.stderr, 'journal|html|json');
}

console.log('\n\x1b[1mI0. --version reports the real version\x1b[0m');
{
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = cli('--version').stdout.trim();
  eq('I0a --version prints a version, not the help text', out.includes('USAGE'), false);
  eq('I0b and it matches package.json', out, pkg.version);

  // The MCP handshake reports a version too, and it had its own hardcoded copy
  // that drifted independently of the CLI's. One source or they disagree.
  const { spawnSync } = await import('node:child_process');
  const hs = spawnSync('node', [CLI, 'mcp', '--book', BOOK], {
    env, input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    encoding: 'utf8', timeout: 15000,
  });
  const info = JSON.parse(hs.stdout.trim().split('\n')[0]).result.serverInfo;
  eq('I0c the MCP handshake reports the same version', info.version, pkg.version);
}

console.log('\n\x1b[1mI. Newly exposed capabilities\x1b[0m');
{
  const alloc = j(cli('allocate', '100.00', '1', '1', '1'));
  eq('I1 allocate splits three ways', alloc.parts.join('/'), '33.34/33.33/33.33');
  eq('I2 and the parts sum exactly', alloc.sum, '100.00');
  const zero = j(cli('allocate', '100.00', '0', '1', '2'));
  eq('I3 a zero ratio gets nothing', zero.parts[0], '0.00');

  const age = j(cli('ageing', 'Assets:Bank:Checking'));
  eq('I4 ageing returns buckets', Array.isArray(age.buckets), true);
  eq('I5 with the standard five', age.buckets.map((b) => b.bucket).join(','),
     'current,1-30,31-60,61-90,90+');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
