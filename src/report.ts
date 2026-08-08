/**
 * Single-file HTML audit report.
 *
 * One file you can email to an accountant, attach to a board pack, or drop in
 * cold storage. It opens from `file://` with no server and makes **no network
 * request at all** — every figure is inlined at export time.
 *
 * Why this and not a PDF: the report carries the chain head and the integrity
 * result, and it is meant to be checked against the book it came from. A PDF
 * flattens that into a picture. Here the reader can open the source, read every
 * number, and re-run `postledger verify-anchors` against the hash printed at the
 * top. A report that cannot be checked is decoration.
 *
 * It reuses the exact page the local web view serves — same code, same numbers,
 * two delivery modes. There is no second renderer to drift out of sync.
 */

import { Ledger } from './ledger.ts';
import { PAGE } from './serve.ts';

/** Escape for safe embedding inside a <script> block. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')     // </script> can't terminate the block
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildReport(book: Ledger, opts: { asOf?: string } = {}): string {
  const snapshot: Record<string, unknown> = {
    '/api/summary': book.info(),
    '/api/accounts': { ok: true, accounts: book.accounts() },
    '/api/trial-balance': book.trialBalance(),
    '/api/balance-sheet': book.balanceSheet(opts.asOf),
    '/api/income-statement': book.incomeStatement({}),
    '/api/entries': book.entries({ limit: 500 }),
    '/api/verify': book.verify(),
    '/api/audit': book.auditSignals(),
    '/api/actors': book.actors(),
    __exported_at__: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  };

  const anchor = book.anchor();
  const verify = snapshot['/api/verify'] as { ok: boolean };

  // A provenance banner, injected right after <body>. It states what this file
  // is and — just as importantly — what it is not.
  const banner = `
<div style="padding:12px 24px;background:${verify.ok ? '#e8f5ee' : '#fbeaea'};
     border-bottom:1px solid ${verify.ok ? '#bfe0cd' : '#e8bcbc'};
     color:${verify.ok ? '#0a6c4a' : '#a02020'};font-size:13px;line-height:1.5">
  <strong>${verify.ok ? 'Integrity checks passed at export time.' : 'INTEGRITY PROBLEMS PRESENT AT EXPORT TIME.'}</strong>
  Chain head <code style="font-family:ui-monospace,monospace">${anchor.hash ?? '(empty book)'}</code>
  at entry #${anchor.seq}.
  <br>
  This is a static snapshot, not a live view. To confirm it still matches the book,
  run <code style="font-family:ui-monospace,monospace">postledger verify</code> against the
  original file and compare the chain head above.
</div>`;

  return PAGE
    .replace('<body>', `<body>\n<script>globalThis.__POSTLEDGER_SNAPSHOT__ = ${safeJson(snapshot)};</script>${banner}`)
    .replace('<title>Postledger</title>',
      `<title>${escapeHtml(book.bookName)} — Postledger audit report</title>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
