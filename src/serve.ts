/**
 * A local, read-only web view of a book.
 *
 * Three deliberate constraints:
 *
 *   1. **Read-only.** Writing is what the CLI and MCP are for. A browser form
 *      that posts entries would need CSRF protection, auth, and a session model
 *      — a lot of attack surface bolted onto a tool whose entire pitch is that
 *      the write path is hard to abuse.
 *   2. **Binds 127.0.0.1 by default.** Your books should not become reachable
 *      because you left a tab open. Exposing it takes an explicit --host, and
 *      the server says out loud what that means.
 *   3. **Zero dependencies.** node:http and a single self-contained HTML page.
 *      No build step, no framework, no CDN — the page you audit is the page
 *      that runs.
 */

import { createServer } from 'node:http';
import { Ledger, PostledgerError } from './ledger.ts';

const json = (res: any, status: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // No third-party anything: the page cannot phone home even if someone
    // slips a script into it.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    'referrer-policy': 'no-referrer',
  });
  res.end(s);
};

export async function runServer(bookPath: string, opts: { port?: number; host?: string } = {}) {
  const port = opts.port ?? 7777;
  const host = opts.host ?? '127.0.0.1';

  // Open once to fail fast on a missing book, then open per request so the
  // server never holds a write lock and always reflects what is on disk.
  Ledger.open(bookPath).close();

  const api: Record<string, (L: Ledger, q: URLSearchParams) => unknown> = {
    '/api/summary':          (L) => L.info(),
    '/api/accounts':         (L) => ({ ok: true, accounts: L.accounts() }),
    '/api/trial-balance':    (L) => L.trialBalance(),
    '/api/balance-sheet':    (L, q) => L.balanceSheet(q.get('as_of') ?? undefined),
    '/api/income-statement': (L, q) => L.incomeStatement({
      from: q.get('from') ?? undefined, to: q.get('to') ?? undefined }),
    '/api/entries':          (L, q) => L.entries({ limit: Number(q.get('limit') ?? 100) }),
    '/api/verify':           (L) => L.verify(),
    '/api/audit':            (L) => L.auditSignals(),
    '/api/actors':           (L) => L.actors(),
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);

    if (req.method !== 'GET') {
      return json(res, 405, { ok: false, error: 'this view is read-only; use the CLI or MCP to write' });
    }

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'referrer-policy': 'no-referrer',
      });
      return res.end(PAGE);
    }

    const handler = api[url.pathname];
    if (!handler) return json(res, 404, { ok: false, error: 'not found' });

    let L: Ledger | null = null;
    try {
      L = Ledger.open(bookPath);
      return json(res, 200, handler(L, url.searchParams));
    } catch (e: any) {
      if (e instanceof PostledgerError) return json(res, 400, e.toJSON());
      return json(res, 500, { ok: false, error: String(e?.message ?? e) });
    } finally {
      L?.close();
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  console.error(`postledger: read-only view of ${bookPath}`);
  console.error(`            http://${host}:${port}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`            ⚠  bound to ${host} — anyone who can reach this address can read your books.`);
  }
  console.error(`            writes are not possible here; use the CLI or MCP for that.`);

  await new Promise<never>(() => {});   // run until killed
}

// ---------------------------------------------------------------------------
// The page. One file, no build, no network.
// ---------------------------------------------------------------------------

export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Postledger</title>
<style>
  :root{
    --bg:#fbfaf8; --panel:#fff; --ink:#1a1a1a; --dim:#6b6b6b; --line:#e6e3dd;
    --pos:#0a6c4a; --neg:#a02020; --accent:#1c4f8f; --warn:#8a5a00;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#14161a; --panel:#1b1e24; --ink:#e8e6e3; --dim:#9a9a9a; --line:#2b2f37;
           --pos:#4ec99a; --neg:#f08a8a; --accent:#7fb0f0; --warn:#e0b060; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;
         align-items:baseline;gap:14px;flex-wrap:wrap}
  h1{font-size:17px;margin:0;font-weight:650;letter-spacing:-.01em}
  .book{color:var(--dim);font-size:13px}
  .chain{font-family:var(--mono);font-size:11px;color:var(--dim);margin-left:auto}
  nav{display:flex;gap:2px;padding:0 16px;border-bottom:1px solid var(--line);
      overflow-x:auto;background:var(--panel)}
  nav button{background:none;border:0;padding:11px 14px;font:inherit;font-size:13.5px;
             color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
  nav button:hover{color:var(--ink)}
  nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent);font-weight:550}
  main{padding:22px 24px;max-width:1080px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;
        padding:16px 18px;margin-bottom:16px}
  .card h2{font-size:13px;margin:0 0 12px;font-weight:600;color:var(--dim);
           text-transform:uppercase;letter-spacing:.06em}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
  th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:600}
  tr:last-child td{border-bottom:0}
  .num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
  .acct{font-family:var(--mono);font-size:13px}
  .pos{color:var(--pos)} .neg{color:var(--neg)}
  .total td{font-weight:650;border-top:2px solid var(--line);border-bottom:0}
  .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:600}
  .pill.ok{background:color-mix(in srgb,var(--pos) 15%,transparent);color:var(--pos)}
  .pill.bad{background:color-mix(in srgb,var(--neg) 15%,transparent);color:var(--neg)}
  .pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
  .stat{padding:12px 14px;border:1px solid var(--line);border-radius:7px}
  .stat .k{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
  .stat .v{font-size:21px;font-family:var(--mono);font-variant-numeric:tabular-nums;margin-top:3px}
  .note{color:var(--dim);font-size:12.5px;margin-top:10px;line-height:1.5}
  .scroll{overflow-x:auto}
  .legs{font-family:var(--mono);font-size:12px;color:var(--dim)}
  .err{color:var(--neg);font-family:var(--mono);font-size:12.5px}
  footer{padding:16px 24px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}
  code{font-family:var(--mono);font-size:.92em}
</style></head><body>
<header>
  <h1>Postledger</h1>
  <span class="book" id="book">loading…</span>
  <span class="chain" id="chain"></span>
</header>
<nav id="nav"></nav>
<main id="view"><div class="card">Loading…</div></main>
<footer>
  <span id="foot">Read-only view. Writes go through the CLI or MCP — this page cannot modify the books.</span>
</footer>
<script>
// One page, two modes. Served live it fetches; exported as a single file it
// reads data inlined at export time — so the exported report opens from
// file:// and makes no network request at all.
const SNAPSHOT = globalThis.__POSTLEDGER_SNAPSHOT__ || null;
const F = async (p) => SNAPSHOT ? SNAPSHOT[p.split('?')[0]] : (await fetch(p)).json();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = (v) => {
  const neg = String(v).startsWith('-');
  return '<span class="num ' + (neg ? 'neg' : '') + '">' + esc(v) + '</span>';
};
const card = (title, inner, note) =>
  '<div class="card"><h2>' + title + '</h2>' + inner + (note ? '<p class="note">' + note + '</p>' : '') + '</div>';
const rows = (arr, cols) =>
  '<div class="scroll"><table><thead><tr>' + cols.map(c => '<th' + (c.num ? ' class="num"' : '') + '>' + c.label + '</th>').join('') +
  '</tr></thead><tbody>' + arr.map(r => '<tr>' + cols.map(c => {
    const v = c.get(r);
    return c.num ? '<td class="num">' + v + '</td>' : '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + v + '</td>';
  }).join('') + '</tr>').join('') + '</tbody></table></div>';

const VIEWS = {
  'Overview': async () => {
    const [s, v, tb] = await Promise.all([F('/api/summary'), F('/api/verify'), F('/api/trial-balance')]);
    const stat = (k, val) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + val + '</div></div>';
    return card('At a glance',
      '<div class="grid">' +
        stat('Entries', s.entries) + stat('Accounts', s.accounts) +
        stat('Documents', s.documents) + stat('Chain length', s.chain_length) +
      '</div>') +
    card('Integrity',
      '<p><span class="pill ' + (v.ok ? 'ok' : 'bad') + '">' + (v.ok ? 'all checks passed' : 'PROBLEMS FOUND') + '</span> ' +
      '<span class="note">' + esc((v.checks_run || []).join(' · ')) + '</span></p>' +
      (v.problems && v.problems.length
        ? '<ul class="err">' + v.problems.map(p => '<li>[' + esc(p.check) + '] ' + esc(p.problem) + '</li>').join('') + '</ul>'
        : ''),
      'The chain check proves entries were not altered. It cannot stop someone with write access to the file — anchor the head somewhere else for that.') +
    card('Trial balance',
      '<p><span class="pill ' + (tb.balanced ? 'ok' : 'bad') + '">' +
      (tb.balanced ? 'balanced' : 'NOT BALANCED') + '</span></p>' +
      '<table><tr><td>Total debits</td><td class="num">' + esc(tb.total_debits) + '</td></tr>' +
      '<tr><td>Total credits</td><td class="num">' + esc(tb.total_credits) + '</td></tr></table>');
  },

  'Accounts': async () => {
    const a = await F('/api/accounts');
    return card('Chart of accounts', rows(a.accounts, [
      { label: 'Account', get: r => '<span class="acct">' + esc(r.id) + '</span>' },
      { label: 'Type', get: r => esc(r.type) },
      { label: 'Balance', num: true, get: r => money(r.balance) },
    ]));
  },

  'Balance sheet': async () => {
    const b = await F('/api/balance-sheet');
    const sec = (s) => card(esc(s.title),
      rows(s.accounts, [
        { label: 'Account', get: r => '<span class="acct">' + esc(r.account) + '</span>' },
        { label: 'Balance', num: true, get: r => money(r.balance) },
      ]) + '<table><tr class="total"><td>Total</td><td class="num">' + esc(s.total) + '</td></tr></table>');
    return card('Accounting identity',
      '<p><span class="pill ' + (b.identity.holds ? 'ok' : 'bad') + '">' +
      (b.identity.holds ? 'assets = liabilities + equity + profit' : 'IDENTITY BROKEN') + '</span></p>' +
      '<table>' +
      '<tr><td>Assets</td><td class="num">' + esc(b.identity.assets) + '</td></tr>' +
      '<tr><td>Liabilities + equity + profit</td><td class="num">' + esc(b.identity.liabilities_plus_equity) + '</td></tr>' +
      '<tr class="total"><td>Difference</td><td class="num">' + esc(b.identity.difference) + '</td></tr></table>',
      b.problem ? esc(b.problem) : 'Checked, not assumed. Money is integer minor units, so one cent of difference is a real difference.')
      + sec(b.assets) + sec(b.liabilities)
      + card('Equity',
          rows(b.equity.accounts, [
            { label: 'Account', get: r => '<span class="acct">' + esc(r.account) + '</span>' },
            { label: 'Balance', num: true, get: r => money(r.balance) },
          ]) +
          '<table><tr><td>Profit this period (not yet closed)</td><td class="num">' +
          esc(b.equity.retained_earnings_this_period) + '</td></tr>' +
          '<tr class="total"><td>Total including profit</td><td class="num">' +
          esc(b.equity.total_including_profit) + '</td></tr></table>');
  },

  'Income': async () => {
    const i = await F('/api/income-statement');
    const sec = (s) => rows(s.accounts, [
      { label: 'Account', get: r => '<span class="acct">' + esc(r.account) + '</span>' },
      { label: 'Amount', num: true, get: r => money(r.balance) },
    ]) + '<table><tr class="total"><td>Total</td><td class="num">' + esc(s.total) + '</td></tr></table>';
    return card('Income', sec(i.income)) + card('Expenses', sec(i.expenses)) +
      card('Result',
        '<table><tr class="total"><td>Net income</td><td class="num ' +
        (i.profitable ? 'pos' : 'neg') + '">' + esc(i.net_income) + '</td></tr></table>',
        'Since inception. Use the CLI with --from/--to for a bounded period.');
  },

  'Journal': async () => {
    const e = await F('/api/entries?limit=200');
    return card('Entries (newest first)', rows(e.entries, [
      { label: '#', num: true, get: r => r.seq },
      { label: 'Date', get: r => esc(r.date) },
      { label: 'Description', get: r => esc(r.description) +
        '<div class="legs">' + r.legs.map(l => esc(l.account) + ' ' + l.side + ' ' + esc(l.amount)).join(' · ') + '</div>' },
      { label: 'Actor', get: r => '<span class="acct">' + esc(r.claimed_actor || '—') + '</span>' },
      { label: 'Total', num: true, get: r => money(r.total) },
    ]), 'The actor column is self-declared, not authenticated.');
  },

  'Forensics': async () => {
    const [a, actors] = await Promise.all([F('/api/audit'), F('/api/actors')]);
    const b = a.benford;
    const bar = (d) => {
      const w = b.sample_size ? Math.round((d.observed / b.sample_size) * 100 * 2.6) : 0;
      const e = Math.round(parseFloat(d.expected_pct) * 2.6);
      return '<tr><td class="num">' + d.digit + '</td>' +
        '<td><div style="height:9px;background:var(--accent);width:' + w + 'px;border-radius:2px;display:inline-block"></div>' +
        '<div style="height:9px;background:var(--dim);opacity:.35;width:' + e + 'px;border-radius:2px;display:inline-block;margin-left:4px"></div></td>' +
        '<td class="num">' + d.observed_pct + '</td><td class="num">' + d.expected_pct + '</td></tr>';
    };
    return card('Benford first-digit distribution',
      (b.applicable
        ? '<p><span class="pill ' + (b.mad_verdict === 'nonconforming' ? 'warn' : 'ok') + '">' +
          esc(b.mad_verdict) + '</span> <span class="note">MAD ' + b.mad + ' · χ² ' + b.chi_square + '</span></p>'
        : '<p><span class="pill warn">not applicable</span></p>') +
      '<table><thead><tr><th class="num">Digit</th><th>Observed vs expected</th>' +
      '<th class="num">Obs</th><th class="num">Exp</th></tr></thead><tbody>' +
      b.digits.map(bar).join('') + '</tbody></table>',
      esc(b.note)) +
    card('Other signals', rows(a.signals, [
      { label: 'Signal', get: r => '<span class="acct">' + esc(r.signal) + '</span>' },
      { label: '', get: r => '<span class="pill ' + (r.severity === 'look' ? 'warn' : 'ok') + '">' + esc(r.severity) + '</span>' },
      { label: 'Finding', get: r => esc(r.finding) },
    ]), esc(a.disclaimer)) +
    card('Who wrote to this book', rows(actors.actors, [
      { label: 'Actor', get: r => '<span class="acct">' + esc(r.actor) + '</span>' },
      { label: 'Entries', num: true, get: r => r.entries },
      { label: 'First', get: r => esc(r.first) },
      { label: 'Last', get: r => esc(r.last) },
    ]), esc(actors.note));
  },
};

let currentTab = 'Overview';
async function render(tab) {
  currentTab = tab;
  document.querySelectorAll('nav button').forEach(b =>
    b.setAttribute('aria-selected', String(b.textContent === tab)));
  const view = document.getElementById('view');
  view.innerHTML = '<div class="card">Loading…</div>';
  try { view.innerHTML = await VIEWS[tab](); }
  catch (e) { view.innerHTML = '<div class="card err">' + esc(e.message) + '</div>'; }
}

(async () => {
  document.getElementById('nav').innerHTML =
    Object.keys(VIEWS).map(k => '<button>' + k + '</button>').join('');
  document.querySelectorAll('nav button').forEach(b =>
    b.addEventListener('click', () => render(b.textContent)));
  const s = await F('/api/summary');
  if (SNAPSHOT) {
    document.getElementById('foot').textContent =
      'Static snapshot exported ' + (SNAPSHOT.__exported_at__ || '') +
      ' — a point-in-time copy, not a live view of the book.';
  }
  document.getElementById('book').textContent = s.book + ' · ' + s.currency;
  document.getElementById('chain').textContent =
    s.chain_head ? 'chain ' + s.chain_head.slice(0, 12) + '… #' + s.chain_length : 'empty book';
  render('Overview');
})();
</script></body></html>`;
