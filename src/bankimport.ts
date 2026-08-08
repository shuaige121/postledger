/**
 * Bank statement CSV → candidate transactions.
 *
 * This deliberately stops short of posting. A statement line says money moved
 * and roughly why; it does not say which account the other side belongs to.
 * Deciding that is a judgement call, and in this system the caller making it is
 * a language model, which is better at it than any regex table. So this parses,
 * normalises and fingerprints — and hands back candidates for the caller to
 * turn into entries.
 *
 * Two things it refuses to guess, both learned from how these imports go wrong:
 *
 *   • **An ambiguous date.** `03/04/2026` is 3 April or 4 March depending on
 *     the bank. If neither component exceeds 12 there is no way to tell, and
 *     picking one silently mis-dates every transaction in the file. It errors
 *     and asks for the format.
 *   • **A sign convention.** On a credit card statement a purchase is usually
 *     printed positive, while in the books a liability increasing is a credit.
 *     Getting this backwards flips every transaction, so it must be stated.
 */

import { Money, type Currency } from './money.ts';

export class ImportError extends Error {
  readonly line: number;
  readonly hint: string;
  constructor(message: string, line: number, hint: string) {
    super(message);
    this.name = 'ImportError';
    this.line = line;
    this.hint = hint;
  }
}

/** Bounds, so a malformed or hostile file fails fast instead of exhausting memory. */
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 100;
const MAX_FIELD = 4_000;

export interface CsvProfile {
  /** Column holding the date. Name (with a header row) or 0-based index. */
  date: string | number;
  /** Column holding the amount, when one signed column carries both directions. */
  amount?: string | number;
  /** Or two columns, when money in and money out are separate. */
  debit?: string | number;
  credit?: string | number;
  description: string | number;
  /** A stable id from the bank (FITID, transaction reference). Far better than a content hash. */
  reference?: string | number;
  /** 'dmy' | 'mdy' | 'ymd'. Omit to auto-detect, which errors on genuinely ambiguous dates. */
  dateFormat?: 'dmy' | 'mdy' | 'ymd';
  /** true when a positive number in the file means money LEAVING (typical of card statements). */
  invertSign?: boolean;
  delimiter?: string;
  hasHeader?: boolean;
}

/** RFC 4180-ish parser: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === delimiter) {
      if (field.length > MAX_FIELD) throw new ImportError(`a field on line ${line} exceeds ${MAX_FIELD} characters`, line, 'This does not look like a bank statement. Check the delimiter.');
      row.push(field); field = '';
      if (row.length > MAX_COLUMNS) throw new ImportError(`line ${line} has more than ${MAX_COLUMNS} columns`, line, 'Check the delimiter — a wrong one turns the whole line into columns.');
      continue;
    }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; line++;
      if (rows.length > MAX_ROWS) throw new ImportError(`more than ${MAX_ROWS} rows`, line, 'Split the file into smaller periods.');
      continue;
    }
    field += c;
  }
  if (quoted) throw new ImportError('the file ends inside a quoted field', line, 'A quote is unclosed somewhere — the file is truncated or malformed.');
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/**
 * Parse a date without guessing.
 *
 * Auto-detection resolves a date only when one component is unambiguously a
 * day (> 12). Otherwise it errors, because picking a convention silently
 * mis-dates the entire file, and a wrong date in a ledger is not obvious later.
 */
export function parseDate(raw: string, format: CsvProfile['dateFormat'], line: number): string {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (!m) {
    throw new ImportError(`cannot read the date ${JSON.stringify(raw)} on line ${line}`, line,
      'Expected something like 2026-08-08, 08/08/2026 or 8.8.2026.');
  }
  const [, aRaw, bRaw, cRaw] = m;
  const a = Number(aRaw), b = Number(bRaw);
  const year = (v: string) => (v.length === 2 ? 2000 + Number(v) : Number(v));
  const pad = (v: number) => String(v).padStart(2, '0');

  if (format === 'ymd' || aRaw!.length === 4) return `${year(aRaw!)}-${pad(b)}-${pad(Number(cRaw))}`;
  if (format === 'dmy') return `${year(cRaw!)}-${pad(b)}-${pad(a)}`;
  if (format === 'mdy') return `${year(cRaw!)}-${pad(a)}-${pad(b)}`;

  if (a > 12 && b <= 12) return `${year(cRaw!)}-${pad(b)}-${pad(a)}`;   // must be d/m
  if (b > 12 && a <= 12) return `${year(cRaw!)}-${pad(a)}-${pad(b)}`;   // must be m/d
  throw new ImportError(
    `the date ${JSON.stringify(raw)} on line ${line} could be either day-first or month-first`, line,
    'Both parts are 12 or less, so there is no way to tell. Pass date_format as "dmy" or "mdy" — ' +
    'guessing would silently mis-date every row in the file.');
}

/** Amounts as banks write them: 1.234,56 · (45.00) for negative · $ and spaces. */
export function parseBankAmount(raw: string, currency: Currency, line: number): Money {
  let s = raw.trim().replace(/[\s ]/g, '').replace(/[$€£¥]/g, '');
  if (!s) throw new ImportError(`empty amount on line ${line}`, line, 'Blank amounts cannot be imported; fix or remove the row.');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }        // accounting parentheses
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);

  // European 1.234,56 vs Anglo 1,234.56 — decided by which separator is last.
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // A lone comma is a decimal separator only if it is not a thousands group.
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  let m: Money;
  try { m = Money.parse(s, currency); }
  catch (e: any) { throw new ImportError(`amount ${JSON.stringify(raw)} on line ${line}: ${e.message}`, line, 'Check the column mapping — this may not be the amount column.'); }
  return negative ? m.negate() : m;
}

export interface Candidate {
  line: number;
  date: string;
  description: string;
  /** Signed, in the book's convention: positive = money into the account being imported. */
  amount: string;
  reference: string | null;
  /** Stable key for this row; the caller should use it as the idempotency key. */
  fingerprint: string;
}

/**
 * Turn a statement into candidates. Nothing is posted — the caller decides
 * which account faces each line and then posts it.
 */
export function readStatement(
  text: string,
  profile: CsvProfile,
  currency: Currency,
  hashFn: (s: string) => string,
): { ok: true; count: number; candidates: Candidate[]; total: string; note: string } {
  const rows = parseCsv(text, profile.delimiter ?? ',');
  if (!rows.length) throw new ImportError('the file has no rows', 0, 'Check that it is a CSV and not empty.');

  const hasHeader = profile.hasHeader ?? true;
  const header = hasHeader ? rows[0]!.map((h) => h.trim().toLowerCase()) : [];
  const idx = (col: string | number | undefined): number | null => {
    if (col === undefined) return null;
    if (typeof col === 'number') return col;
    const i = header.indexOf(col.trim().toLowerCase());
    if (i < 0) {
      throw new ImportError(`no column named ${JSON.stringify(col)}`, 1,
        `Columns present: ${header.join(', ') || '(no header row — use numeric indexes)'}`);
    }
    return i;
  };

  const cDate = idx(profile.date)!, cDesc = idx(profile.description)!;
  const cAmount = idx(profile.amount), cDebit = idx(profile.debit), cCredit = idx(profile.credit);
  const cRef = idx(profile.reference);
  if (cAmount === null && (cDebit === null || cCredit === null)) {
    throw new ImportError('no amount column configured', 1,
      'Give either amount (one signed column) or both debit and credit.');
  }

  const seen = new Map<string, number>();
  const candidates: Candidate[] = [];
  const body = hasHeader ? rows.slice(1) : rows;

  body.forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    if (r.every((f) => !f.trim())) return;                      // blank line

    const date = parseDate(r[cDate] ?? '', profile.dateFormat, line);
    const description = (r[cDesc] ?? '').trim();
    let amount: Money;
    if (cAmount !== null) {
      amount = parseBankAmount(r[cAmount] ?? '', currency, line);
    } else {
      const d = (r[cDebit!] ?? '').trim(), c = (r[cCredit!] ?? '').trim();
      if (d && c) throw new ImportError(`line ${line} fills both the debit and credit columns`, line, 'A statement row moves money one way. Check the mapping.');
      amount = d ? parseBankAmount(d, currency, line).negate() : parseBankAmount(c, currency, line);
    }
    if (profile.invertSign) amount = amount.negate();

    const reference = cRef !== null ? ((r[cRef] ?? '').trim() || null) : null;
    // A bank reference is a real identity; fall back to content only without one.
    const basis = reference
      ? `ref:${reference}`
      : `content:${date}|${amount.minor}|${description.replace(/\s+/g, ' ').toLowerCase()}`;
    const base = hashFn(basis).slice(0, 16);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);

    candidates.push({
      line, date, description, amount: amount.format(), reference,
      fingerprint: nth > 1 ? `${base}#${nth}` : base,
    });
  });

  const total = candidates.reduce((s, c) => s.add(Money.parse(c.amount, currency)), Money.zero(currency));
  const withoutRef = candidates.filter((c) => !c.reference).length;

  return {
    ok: true, count: candidates.length, candidates, total: total.format(),
    note:
      'Nothing has been posted. Each candidate needs an account for the other side — that is a judgement ' +
      'call, which is why it is left to you. Use the fingerprint as the idempotency key when posting, ' +
      'so re-importing the same statement is a no-op.' +
      (withoutRef
        ? ` ${withoutRef} row(s) had no bank reference, so their fingerprints come from content; if the bank ` +
          'offers a reference column, map it — two genuinely identical rows are indistinguishable without one.'
        : ''),
  };
}
