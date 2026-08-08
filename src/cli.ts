#!/usr/bin/env node
/**
 * postledger CLI —— the Unix contract.
 *
 *   stdout carries only data, stderr carries only logs and errors  → safe to pipe into | jq
 *   JSON by default, --table for humans, --tsv for awk             → each consumer gets what it wants
 *   exit codes are meaningful                                      → `if postledger verify; then ...` just works
 *
 * The book file comes from --book or POSTLEDGER_BOOK; if neither is set, we error out — no guessing.
 */

import { Ledger, PostledgerError } from './ledger.ts';
import { readFileSync } from 'node:fs';
import { VERSION } from './version.ts';

// Exit codes are part of the interface — scripts will depend on them
const EXIT = {
  OK: 0,
  ERROR: 1,          // generic error
  VALIDATION: 2,     // validation failed: debits/credits don't balance, total mismatch, bad date, ...
  IDEMPOTENCY: 3,    // idempotency conflict
  BOOK: 4,           // book missing or can't be opened
  VERIFY: 5,         // integrity check failed
} as const;

const CODE_TO_EXIT: Record<string, number> = {
  UNBALANCED: EXIT.VALIDATION, EXPECTED_TOTAL_MISMATCH: EXIT.VALIDATION,
  BAD_DATE: EXIT.VALIDATION, BAD_AMOUNT: EXIT.VALIDATION, BAD_SIDE: EXIT.VALIDATION,
  TOO_FEW_LEGS: EXIT.VALIDATION, MISSING_DESCRIPTION: EXIT.VALIDATION,
  NON_POSITIVE_AMOUNT: EXIT.VALIDATION, BALANCE_ASSERTION_FAILED: EXIT.VALIDATION,
  UNKNOWN_ACCOUNT: EXIT.VALIDATION, CLOSED_ACCOUNT: EXIT.VALIDATION,
  BAD_ACCOUNT_NAME: EXIT.VALIDATION, PERIOD_LOCKED: EXIT.VALIDATION,
  MISSING_IDEMPOTENCY_KEY: EXIT.VALIDATION,
  IDEMPOTENCY_CONFLICT: EXIT.IDEMPOTENCY, IDEMPOTENCY_IN_PROGRESS: EXIT.IDEMPOTENCY,
  BOOK_NOT_FOUND: EXIT.BOOK, BOOK_EXISTS: EXIT.BOOK, ANCHORS_NOT_FOUND: EXIT.BOOK,
};

// -- Argument parsing (no dependency pulled in — argv parsing is small enough to just write) ----

interface Args { _: string[]; flags: Record<string, string | boolean>; repeated: Record<string, string[]> }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, repeated: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const key = k!;
      const next = argv[i + 1];
      const val = inline !== undefined ? inline
        : next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      if (out.flags[key] !== undefined || out.repeated[key]) {
        out.repeated[key] = [...(out.repeated[key] ?? [String(out.flags[key])]), String(val)];
      }
      out.flags[key] = val;
    } else out._.push(a);
  }
  return out;
}

const bookPath = (a: Args): string => {
  const p = (a.flags.book as string) || process.env.POSTLEDGER_BOOK;
  if (!p) {
    console.error('postledger: no book specified. Use --book <file> or set POSTLEDGER_BOOK.');
    process.exit(EXIT.BOOK);
  }
  return p;
};

// -- Output -------------------------------------------------------------------

function emit(data: unknown, a: Args): void {
  if (a.flags.tsv) { console.log(toTsv(data)); return; }
  if (a.flags.table) { console.log(toTable(data)); return; }
  console.log(JSON.stringify(data, null, a.flags.compact ? 0 : 2));
}

function toTsv(data: any): string {
  const rows: any[] = Array.isArray(data) ? data
    : data.accounts ?? data.entries ?? data.actors ?? data.documents ?? [data];
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]).filter((c) => typeof rows[0][c] !== 'object');
  return [cols.join('\t'), ...rows.map((r) => cols.map((c) => r[c] ?? '').join('\t'))].join('\n');
}

function toTable(data: any): string {
  const rows: any[] = Array.isArray(data) ? data
    : data.accounts ?? data.entries ?? data.actors ?? data.documents ?? null;
  if (!rows?.length) {
    return Object.entries(data).filter(([, v]) => typeof v !== 'object')
      .map(([k, v]) => `${k.padEnd(18)} ${v}`).join('\n');
  }
  const cols = Object.keys(rows[0]).filter((c) => typeof rows[0][c] !== 'object');
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(w[i]!)).join('  ');
  return [line(cols), line(w.map((n) => '─'.repeat(n))),
          ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ''))))].join('\n');
}

// -- Shorthand syntax for posting legs ---------------------------------------
//   --leg "Assets:Bank:Checking debit 5000.00"
// Deliberately positional rather than JSON: easy to type by hand, easy to
// generate from a script, and easy to read either way.
function parseLeg(s: string) {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new PostledgerError(`cannot parse leg ${JSON.stringify(s)}`, 'BAD_LEG',
      'Format is: --leg "Account:Path debit 123.45"');
  }
  const [account, side, amount, ...memo] = parts;
  return { account: account!, side: side as 'debit' | 'credit', amount: amount!,
           memo: memo.length ? memo.join(' ') : undefined };
}

const legsOf = (a: Args): any[] => {
  const raw = a.repeated.leg ?? (a.flags.leg ? [String(a.flags.leg)] : []);
  return raw.map(parseLeg);
};

// -- Commands -------------------------------------------------------------------

const HELP = `postledger — idempotent double-entry bookkeeping for AI agents

USAGE
  postledger <command> [--book <file>] [options]
  (or set POSTLEDGER_BOOK=<file>)

BOOK
  init <file> --name <name> --currency SGD    create a book (one file = one book)
  info                                        book summary + chain head
  close <YYYY-MM-DD> [--name <n>] [--note <t>] close a period; nothing on/before it
  close reopen <seq> --reason <text>           reopen a close (recorded)
  periods                                      every close, including reopened
  lock <YYYY-MM-DD>                            legacy alias for close

ACCOUNTS
  account open <Path:Like:This> --type asset|liability|equity|income|expense
  accounts                                    list accounts with balances

POSTING
  post --key <k> --date <d> --desc <text> \\
       --leg "Acct debit 100.00" --leg "Acct credit 100.00" --expect-total 100.00
       [--actor <who>] [--expect-balance "Acct 500.00"] [--dry-run]
  reverse <entry-id> --key <k> --reason <text>
  revert-actor <actor> --key <k> --reason <text> [--since <d>] [--dry-run]

READING
  balance <account> [--as-of <d>] [--subtree]  one account, optionally at a date
  balances [prefix]                           subtree totals
  trial-balance                               the books must balance
  balance-sheet [--as-of <d>]                 assets = liabilities + equity + profit
  income-statement [--from <d>] [--to <d>]    income - expenses for a period
  entries [--account <a>] [--since <d>] [--until <d>] [--actor <who>]
          [--tag <k>] [--tag-value <v>] [--tax-code <c>] [--describes <text>]
          [--min <amt>] [--max <amt>] [--before-seq <n>] [--limit <n>]
  actors                                      who has written to this book
  ageing <account> [--as-of <d>]              how old is the money in one account
  allocate <amount> <ratio> [ratio...]        split an amount, losing no cent
  convert <amount> <from> --rate <r>          convert exactly, no floating point
  by-actor <actor>                            what one actor wrote

INTEROP
  export [--format journal|html|json]          journal for hledger, or a
              [--no-tags] [--as-of <d>]         single-file HTML audit report
  import <file> [--dry-run] [--actor <who>]   import a hledger/ledger journal
  read-statement <file.csv> [--date <col>]    parse a bank CSV into candidates
       [--amount <col> | --debit <col> --credit <col>] [--desc <col>] [--ref <col>]
       [--date-format dmy|mdy|ymd] [--invert-sign] [--no-header]

INTEGRITY
  assert <account> <amount> [--subtree]       confirm a balance against reality
  assert --generate                           snapshot every asset/liability balance
  assertions [account]                        every balance ever confirmed
  stale-assertions [--days 30]                asserted once, moved a lot since
  verify [--no-chain] [--no-balance] [--no-documents] [--no-assertions]
  verify-anchors <anchor-log>                 check against external witnesses
  anchor [--line]                             print the chain head to anchor elsewhere
  audit [--account <a>]                       statistical indicators (NOT evidence)

DOCUMENTS
  attach <entry-id> <file> --kind invoice|receipt|contract|statement|bank_slip|other --key <k>
  docs <entry-id>                             documents linked to an entry

WEB
  serve [--port 7777] [--host 127.0.0.1]      read-only browser view (localhost only by default)

MCP
  mcp                                         run as an MCP server over stdio

OUTPUT
  --table       human-readable columns
  --tsv         tab-separated, for awk/cut
  --compact     single-line JSON
  default is indented JSON on stdout; logs and errors go to stderr

EXIT CODES
  0 ok   1 error   2 validation failed   3 idempotency conflict
  4 book problem   5 integrity check failed
`;

async function main() {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  const cmd = a._[0];

  // --version must be checked before the help fallback: it arrives as a flag,
  // so `cmd` is undefined and `!cmd` would swallow it and print help instead.
  if (a.flags.version || a.flags.v) { console.log(VERSION); return EXIT.OK; }
  if (!cmd || a.flags.help || cmd === 'help') { console.log(HELP); return EXIT.OK; }

  // Every command other than init and mcp needs the book open
  if (cmd === 'init') {
    const file = a._[1];
    if (!file) { console.error('postledger: init needs a file path'); return EXIT.BOOK; }
    const L = Ledger.create(file, {
      name: String(a.flags.name ?? 'Untitled'),
      currency: String(a.flags.currency ?? 'SGD'),
    });
    emit(L.info(), a);
    L.close();
    return EXIT.OK;
  }

  if (cmd === 'serve') {
    const { runServer } = await import('./serve.ts');
    await runServer(bookPath(a), {
      port: a.flags.port ? Number(a.flags.port) : undefined,
      host: a.flags.host ? String(a.flags.host) : undefined,
    });
    return EXIT.OK;
  }

  if (cmd === 'mcp') {
    const { runMcpServer } = await import('./mcp.ts');
    await runMcpServer(bookPath(a));
    return EXIT.OK;
  }

  const L = Ledger.open(bookPath(a));
  try {
    switch (cmd) {
      case 'info':          emit(L.info(), a); break;
      case 'accounts':      emit(L.accounts(), a); break;

      case 'account': {
        if (a._[1] !== 'open') { console.error('postledger: usage: account open <path> --type <type>'); return EXIT.ERROR; }
        emit(L.openAccount(a._[2]!, String(a.flags.type) as any,
          { allowNegative: !!a.flags['allow-negative'], note: a.flags.note as string }), a);
        break;
      }

      case 'post': {
        const expectBalance = a.flags['expect-balance']
          ? (() => { const [acct, bal] = String(a.flags['expect-balance']).trim().split(/\s+/);
                     return { account: acct!, balance: bal! }; })()
          : undefined;
        emit(L.post({
          idempotencyKey: String(a.flags.key ?? ''),
          date: String(a.flags.date ?? new Date().toISOString().slice(0, 10)),
          description: String(a.flags.desc ?? a.flags.description ?? ''),
          legs: legsOf(a),
          expectedTotal: String(a.flags['expect-total'] ?? ''),
          actor: a.flags.actor ? String(a.flags.actor) : undefined,
          expectBalanceAfter: expectBalance,
        }, { dryRun: !!a.flags['dry-run'] }), a);
        break;
      }

      case 'reverse':
        emit(L.reverse(a._[1]!, { idempotencyKey: String(a.flags.key ?? ''),
          reason: String(a.flags.reason ?? ''), actor: a.flags.actor as string }), a);
        break;

      case 'revert-actor':
        emit(L.revertActor(a._[1]!, {
          idempotencyKey: String(a.flags.key ?? ''),
          reason: String(a.flags.reason ?? ''),
          since: a.flags.since as string, until: a.flags.until as string,
          dryRun: !!a.flags['dry-run'],
        }), a);
        break;

      case 'balance':
        emit(L.balance(a._[1]!, { asOf: a.flags['as-of'] as string, subtree: !!a.flags.subtree }), a);
        break;
      case 'balances':      emit(L.balanceTree(a._[1] ?? ''), a); break;
      case 'trial-balance': {
        const tb = L.trialBalance();
        emit(tb, a);
        if (!tb.balanced) return EXIT.VERIFY;
        break;
      }
      case 'balance-sheet': {
        const bs = L.balanceSheet(a.flags['as-of'] as string);
        emit(bs, a);
        // A balance sheet whose identity does not hold is not a report, it is a
        // fault report — say so through the exit code too.
        if (!bs.ok) return EXIT.VERIFY;
        break;
      }

      case 'income-statement':
        emit(L.incomeStatement({ from: a.flags.from as string, to: a.flags.to as string }), a);
        break;

      case 'export': {
        const fmt = String(a.flags.format ?? 'journal');
        if (fmt === 'journal') {
          // Journal goes to stdout raw, not wrapped in JSON — so it can be
          // piped straight into hledger.
          process.stdout.write(L.exportJournal({ includeTags: !a.flags['no-tags'] }));
        } else if (fmt === 'html') {
          // A single self-contained file: opens from file://, no network, and
          // carries the chain head so the reader can check it against the book.
          const { buildReport } = await import('./report.ts');
          process.stdout.write(buildReport(L, { asOf: a.flags['as-of'] as string }));
        } else if (fmt === 'json') {
          emit(L.entries({ limit: 500 }), a);
        } else {
          console.error(`postledger: unknown export format ${JSON.stringify(fmt)} (journal|html|json)`);
          return EXIT.ERROR;
        }
        break;
      }

      case 'import': {
        const file = a._[1];
        if (!file) { console.error('postledger: import needs a file path'); return EXIT.ERROR; }
        emit(L.importJournal(readFileSync(file, 'utf8'), {
          source: file.split('/').pop() ?? file,
          actor: a.flags.actor as string,
          dryRun: !!a.flags['dry-run'],
        }), a);
        break;
      }

      case 'entries':
        emit(L.entries({
          limit: a.flags.limit ? Number(a.flags.limit) : undefined,
          account: a.flags.account as string, since: a.flags.since as string,
          until: a.flags.until as string, actor: a.flags.actor as string,
          describes: a.flags.describes as string,
          tag: a.flags.tag as string, tagValue: a.flags['tag-value'] as string,
          taxCode: a.flags['tax-code'] as string,
          minAmount: a.flags.min as string, maxAmount: a.flags.max as string,
          beforeSeq: a.flags['before-seq'] ? Number(a.flags['before-seq']) : undefined,
        }), a);
        break;
      case 'actors':        emit(L.actors(), a); break;
      case 'close': {
        if (a._[1] === 'reopen') {
          emit(L.reopenPeriod(Number(a._[2]), String(a.flags.reason ?? ''), { actor: a.flags.actor as string }), a);
        } else {
          emit(L.closePeriod(String(a.flags.name ?? `closed through ${a._[1]}`), a._[1]!,
            { actor: a.flags.actor as string, note: a.flags.note as string }), a);
        }
        break;
      }
      case 'periods':       emit(L.periods(), a); break;
      case 'read-statement': {
        const file = a._[1];
        if (!file) { console.error('postledger: read-statement needs a CSV file'); return EXIT.ERROR; }
        emit(L.readStatement(readFileSync(file, 'utf8'), {
          date: a.flags.date as string ?? 'date',
          amount: a.flags.amount as string,
          debit: a.flags.debit as string, credit: a.flags.credit as string,
          description: a.flags.desc as string ?? 'description',
          reference: a.flags.ref as string,
          dateFormat: a.flags['date-format'] as any,
          invertSign: !!a.flags['invert-sign'],
          delimiter: a.flags.delimiter as string,
          hasHeader: !a.flags['no-header'],
        }), a);
        break;
      }
      case 'assert': {
        if (a.flags.generate) {
          emit(L.generateAssertions({ actor: a.flags.actor as string, note: a.flags.note as string }), a);
        } else {
          emit(L.assertBalance(a._[1]!, a._[2]!, {
            subtree: !!a.flags.subtree, note: a.flags.note as string,
            actor: a.flags.actor as string, date: a.flags.date as string,
          }), a);
        }
        break;
      }
      case 'assertions':    emit(L.assertions({ account: a._[1], limit: a.flags.limit ? Number(a.flags.limit) : undefined }), a); break;
      case 'stale-assertions': {
        const st = L.staleAssertions({ withinDays: a.flags.days ? Number(a.flags.days) : undefined });
        emit(st, a);
        if (!st.ok) return EXIT.VERIFY;
        break;
      }
      case 'ageing':        emit(L.ageing(a._[1]!, { asOf: a.flags['as-of'] as string }), a); break;
      case 'convert':
        emit(L.convert(a._[1]!, a._[2]!, String(a.flags.rate ?? ''), { to: a.flags.to as string }), a);
        break;
      case 'allocate':
        emit(L.allocate(a._[1]!, a._.slice(2).map(Number)), a);
        break;
      case 'by-actor':      emit(L.entriesByActor(a._[1]!), a); break;

      case 'verify': {
        const v = L.verify({
          chain: !a.flags['no-chain'], balance: !a.flags['no-balance'],
          documents: !a.flags['no-documents'], assertions: !a.flags['no-assertions'],
        });
        emit(v, a);
        if (!v.ok) return EXIT.VERIFY;
        break;
      }

      case 'verify-anchors': {
        const v = L.verifyAgainstAnchors(a._[1]!);
        emit(v, a);
        if (!v.ok) return EXIT.VERIFY;
        break;
      }

      case 'anchor': {
        const an = L.anchor();
        // --line prints a single bare line, so `postledger anchor --line >> anchors.log` just works
        if (a.flags.line) { console.log(an.line); break; }
        emit(an, a);
        break;
      }

      case 'audit':
        emit(L.auditSignals({ account: a.flags.account as string,
          thresholds: a.flags.thresholds ? String(a.flags.thresholds).split(',').map(Number) : undefined }), a);
        break;

      case 'attach':
        emit(L.attach(a._[1]!, a._[2]!, String(a.flags.kind ?? 'other'),
          { idempotencyKey: String(a.flags.key ?? '') }), a);
        break;

      case 'docs':          emit(L.documentsOf(a._[1]!), a); break;
      case 'lock':          emit(L.lock(a._[1]!), a); break;

      default:
        console.error(`postledger: unknown command ${JSON.stringify(cmd)}\n`);
        console.error(HELP);
        return EXIT.ERROR;
    }
  } finally {
    L.close();
  }
  return EXIT.OK;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof PostledgerError) {
      // The structured error also goes to stdout, so `postledger post ... | jq .hint`
      // still works even on failure; the human-readable line goes to stderr.
      console.log(JSON.stringify(e.toJSON(), null, 2));
      console.error(`postledger: ${e.message}`);
      if (e.hint) console.error(`hint: ${e.hint}`);
      process.exit(CODE_TO_EXIT[e.code] ?? EXIT.ERROR);
    }
    console.error(`postledger: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  });
