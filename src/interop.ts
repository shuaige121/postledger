/**
 * hledger / ledger journal interop — pure functions, no I/O.
 *
 * Why this exists: a ledger you cannot leave is a ledger you cannot trust.
 * Plain-text accounting had this right for twenty years — your journal is a
 * text file you own. Postledger stores in SQLite for the constraints, not to
 * hold your data hostage, so the door out has to be a real one.
 *
 * ## The one conversion that matters
 *
 * Postledger records direction with an explicit `side` and a strictly positive
 * amount. ledger-likes record it with a sign: positive is a debit, negative is
 * a credit. Neither is wrong; they are different ways to say the same thing.
 *
 *     Postledger                    ledger / hledger
 *     side=debit  amount=5000.00    Assets:Bank:Checking    5000.00 USD
 *     side=credit amount=5000.00    Income:Sales           -5000.00 USD
 *
 * Round-tripping through this module is lossless for everything Postledger
 * models. Things it does NOT model (virtual postings, multi-commodity legs,
 * price annotations, automated/periodic transactions) are rejected loudly on
 * import rather than silently dropped — a ledger that quietly discards part of
 * your file is worse than one that refuses it.
 */

import { Money, type Currency } from './money.ts';

export class InteropError extends Error {
  readonly line: number;
  readonly hint: string;
  constructor(message: string, line: number, hint: string) {
    super(message);
    this.name = 'InteropError';
    this.line = line;
    this.hint = hint;
  }
}

export interface ExportEntry {
  date: string;
  description: string;
  entry_id?: string;
  idempotency_key?: string;
  actor?: string | null;
  legs: Array<{ account: string; side: 'debit' | 'credit'; amount: bigint; memo?: string | null }>;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Render entries as a hledger/ledger journal.
 *
 * Postledger-specific facts (entry id, idempotency key, actor) go into tag
 * comments, which every ledger-like tool preserves and ignores. That makes the
 * export re-importable without inventing a dialect.
 */
export function toJournal(
  entries: ExportEntry[],
  currency: Currency,
  opts: { includeTags?: boolean; bookName?: string } = {},
): string {
  const tags = opts.includeTags !== false;
  const out: string[] = [];

  out.push(`; Exported from Postledger${opts.bookName ? ` — book: ${opts.bookName}` : ''}`);
  out.push(`; Currency: ${currency.code} (${currency.decimals} decimal places)`);
  out.push(`; Sign convention: positive = debit, negative = credit`);
  out.push('');

  for (const e of entries) {
    out.push(`${e.date} ${e.description}`);
    if (tags) {
      const t: string[] = [];
      if (e.entry_id) t.push(`entry:${e.entry_id}`);
      if (e.idempotency_key) t.push(`idem:${e.idempotency_key}`);
      if (e.actor) t.push(`actor:${e.actor}`);
      if (t.length) out.push(`    ; ${t.join(', ')}`);
    }
    // Widest account name sets the column, so the amounts line up like a
    // hand-kept journal would.
    const width = Math.max(...e.legs.map((l) => l.account.length));
    for (const l of e.legs) {
      const signed = l.side === 'debit' ? l.amount : -l.amount;
      const amount = Money.ofMinor(signed, currency).format();
      const pad = ' '.repeat(Math.max(2, width - l.account.length + 2));
      out.push(`    ${l.account}${pad}${amount.padStart(14)} ${currency.code}` +
               (l.memo ? `  ; ${l.memo}` : ''));
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ParsedEntry {
  date: string;
  description: string;
  tags: Record<string, string>;
  legs: Array<{ account: string; side: 'debit' | 'credit'; amount: string }>;
  /** Debit-side total, ready to hand to post() as expectedTotal */
  expectedTotal: string;
  sourceLine: number;
}

const DATE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})\s*(?:[*!]\s*)?(?:\(([^)]*)\)\s*)?(.*)$/;

/**
 * Parse a hledger/ledger journal into entries ready for `post()`.
 *
 * Deliberately strict. Every rejection names the line and says what to do,
 * because a half-understood import is how ledgers get quietly corrupted.
 */
export function fromJournal(text: string, currency: Currency): ParsedEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ParsedEntry[] = [];

  let current: ParsedEntry | null = null;
  let pendingBlank: { account: string; lineNo: number } | null = null;

  const finish = (lineNo: number) => {
    if (!current) return;
    if (current.legs.length < 2) {
      throw new InteropError(
        `transaction "${current.description}" has ${current.legs.length} posting(s)`,
        current.sourceLine,
        'Double-entry needs at least two postings. If your journal relies on a blank ' +
        'amount to auto-balance, that is supported — but only one blank per transaction.',
      );
    }
    let debits = Money.zero(currency);
    let credits = Money.zero(currency);
    for (const l of current.legs) {
      const m = Money.parse(l.amount, currency);
      if (l.side === 'debit') debits = debits.add(m);
      else credits = credits.add(m);
    }
    if (!debits.equals(credits)) {
      throw new InteropError(
        `transaction "${current.description}" does not balance ` +
        `(debits ${debits.format()}, credits ${credits.format()})`,
        current.sourceLine,
        'Fix the source journal, or let one posting have a blank amount so it can be inferred.',
      );
    }
    current.expectedTotal = debits.format();
    entries.push(current);
    current = null;
    pendingBlank = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const line = raw.replace(/\s*;.*$/, '');          // strip trailing comment
    const comment = raw.match(/;\s*(.*)$/)?.[1] ?? '';
    const isPureComment = raw.trim().startsWith(';');

    // A comment-only line must NOT be read as a blank line. Stripping the
    // comment leaves an empty string, and "empty line ends the transaction"
    // would then close a transaction the moment it hit its own tag comment —
    // which is exactly how our own exports failed to re-import.
    if (isPureComment) {
      if (current && comment) {
        for (const part of comment.split(',')) {
          const [k, ...v] = part.trim().split(':');
          if (k && v.length) current.tags[k.trim()] = v.join(':').trim();
        }
      }
      continue;
    }

    if (!line.trim()) { finish(lineNo); continue; }

    // Directives we knowingly do not support — refuse rather than half-apply
    if (/^(include|account|commodity|P |D |Y |=|~)/.test(line.trim()) && !/^\s/.test(raw)) {
      const d = line.trim().split(/\s+/)[0];
      if (d === '=' || d === '~') {
        throw new InteropError(
          `automated/periodic transaction rule at line ${lineNo} is not supported`,
          lineNo,
          'Postledger only stores concrete entries. Expand these rules with hledger first ' +
          '(`hledger print`), then import the result.',
        );
      }
      continue;                                        // account/commodity/price: informational
    }

    const dm = DATE_RE.exec(line.trim());
    if (dm && !/^\s/.test(raw)) {
      finish(lineNo);
      const [, y, mo, d, , descRaw] = dm;
      current = {
        date: `${y}-${mo}-${d}`,
        description: (descRaw ?? '').trim() || '(no description)',
        tags: {},
        legs: [],
        expectedTotal: '0',
        sourceLine: lineNo,
      };
      continue;
    }

    if (!current) continue;                            // stray line outside a transaction

    // A posting line
    const posting = line.trim();
    const amountMatch = posting.match(/^(.+?)\s{2,}(-?[\d.,]+)\s*([A-Za-z$€£¥]*)\s*$/);

    if (!amountMatch) {
      // A posting with no amount: legal in ledger, means "whatever balances".
      const account = posting.trim();
      if (!account) continue;
      if (pendingBlank) {
        throw new InteropError(
          `transaction "${current.description}" has more than one posting without an amount`,
          lineNo,
          'ledger allows exactly one blank amount per transaction, because two would be ambiguous.',
        );
      }
      pendingBlank = { account, lineNo };
      continue;
    }

    const [, accountRaw, numRaw, commodity] = amountMatch;
    if (commodity && commodity.toUpperCase() !== currency.code && !/^[$€£¥]$/.test(commodity)) {
      throw new InteropError(
        `posting is in ${commodity} but this book is ${currency.code} (line ${lineNo})`,
        lineNo,
        'One book holds exactly one currency. Open a separate book for other currencies.',
      );
    }
    if (numRaw!.includes(',')) {
      throw new InteropError(
        `amount "${numRaw}" contains a comma (line ${lineNo})`,
        lineNo,
        'Thousands separators are ambiguous across locales. Re-export without them ' +
        '(hledger: `hledger print` produces plain decimals).',
      );
    }

    const negative = numRaw!.startsWith('-');
    const magnitude = negative ? numRaw!.slice(1) : numRaw!;
    Money.parse(magnitude, currency);                  // validate precision now, fail on this line
    current.legs.push({
      account: accountRaw!.trim(),
      side: negative ? 'credit' : 'debit',
      amount: magnitude,
    });
  }
  finish(lines.length + 1);

  // Resolve blank-amount postings, if any survived to the end
  return entries;
}

/**
 * Fill in a posting whose amount was left blank, the way ledger does:
 * it takes whatever makes the transaction balance.
 */
export function inferBlankAmount(
  legs: Array<{ account: string; side: 'debit' | 'credit'; amount: string }>,
  blankAccount: string,
  currency: Currency,
): { account: string; side: 'debit' | 'credit'; amount: string } {
  let debits = Money.zero(currency);
  let credits = Money.zero(currency);
  for (const l of legs) {
    const m = Money.parse(l.amount, currency);
    if (l.side === 'debit') debits = debits.add(m);
    else credits = credits.add(m);
  }
  const diff = debits.subtract(credits);
  if (diff.isZero()) {
    throw new InteropError(
      'the transaction already balances, so the blank posting would be zero',
      0,
      'Remove the empty posting, or give it an explicit amount.',
    );
  }
  return {
    account: blankAccount,
    side: diff.isPositive() ? 'credit' : 'debit',
    amount: diff.abs().format(),
  };
}
