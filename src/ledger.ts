/**
 * The postledger engine.
 *
 * The write protocol has exactly one path: postings land first, the entry
 * head lands after. At the moment of sealing, a database trigger validates
 * the whole entry (debits equal credits, leg count matches what was
 * declared, the total matches what was declared).
 * See src/schema.sql — the accounting invariants live there, not here.
 * What this file is responsible for: idempotency, the hash chain, and
 * giving an unreliable caller an error it can self-correct from.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Money, currencyOf, type Currency } from './money.ts';
import { benford, roundNumbers, duplicateAmounts, thresholdClustering, outliers, timingPattern } from './audit.ts';
import { balanceSheet, incomeStatement, ageing, type BalanceRow } from './reports.ts';
import { toJournal, fromJournal, type ExportEntry } from './interop.ts';
import { migrate, CURRENT_SCHEMA_VERSION } from './migrations.ts';
import { readStatement, type CsvProfile } from './bankimport.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Errors: every one carries a code and a hint.
// The hint must be the **next action**, not a restatement of the problem —
// because whatever reads it is a model that will act on it.
// ---------------------------------------------------------------------------

export class PostledgerError extends Error {
  // Note: deliberately not using TypeScript's parameter properties
  // (constructor(readonly code: string)) here. Node's native .ts execution
  // is strip-only — it deletes types and generates nothing — but parameter
  // properties need an emitted assignment statement. Using them would force
  // a build step, and "zero build, zero dependencies" is a deliberate
  // trade-off for this project.
  readonly code: string;
  readonly hint: string;
  readonly detail: Record<string, unknown>;

  constructor(message: string, code: string, hint: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PostledgerError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
  toJSON() {
    return { ok: false, error_code: this.code, error: this.message, hint: this.hint, ...this.detail };
  }
}

const err = (code: string, message: string, hint: string, detail = {}) =>
  new PostledgerError(message, code, hint, detail);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type Side = 'debit' | 'credit';

export interface LegInput {
  account: string;
  side: Side;
  /** Tax code as it applied AT THE TIME, e.g. "VAT21", "GST8", "exempt". Recorded, never computed with. */
  taxCode?: string;
  /** Tax portion of this leg, decimal string. A snapshot of a historical fact, not a rate lookup. */
  taxAmount?: string;
  /** Original currency, when this leg was converted from another. */
  fxCurrency?: string;
  /** Original amount in that currency, decimal string. */
  fxAmount?: string;
  /** A decimal string. **JSON numbers are not accepted** — see money.ts for why. */
  amount: string;
  memo?: string;
}

export interface PostInput {
  idempotencyKey: string;
  date: string;
  description: string;
  legs: LegInput[];
  /** The debit-side total, computed independently by the caller. If it doesn't match the sum of the legs, the whole entry is rejected. */
  expectedTotal: string;
  actor?: string;
  /**
   * Free-form labels, orthogonal to the chart of accounts: project, client,
   * cost centre. Covered by the entry hash, which means they cannot be applied
   * afterwards — a tag you can add later is a tag you can change later.
   */
  tags?: Record<string, string>;
  /** An optional stronger assertion: what a given account's balance should be after this entry posts */
  expectBalanceAfter?: { account: string; balance: string };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
};
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/**
 * The exact bytes an entry's hash covers. Written once and used by BOTH the
 * write path and `verify` — two copies of this would eventually differ by a
 * field, and every hash in every book would silently stop matching.
 *
 * Optional fields are included **only when present**. That is what keeps books
 * written by earlier versions verifiable: an entry recorded before tags or the
 * tax columns existed hashed a payload without those keys, so omitting them
 * when absent reproduces the original bytes exactly. Including a key
 * unconditionally would invalidate every historical hash at once.
 */
export interface PayloadLeg {
  account: string; side: string; amount: string; memo: string | null;
  tax_code?: string | null; tax_amount?: string | null;
  fx_currency?: string | null; fx_amount?: string | null;
}

function entryPayload(e: {
  id: string; date: string; description: string; legs: PayloadLeg[];
  declared_total: string; claimed_actor: string | null;
  idempotency_key: string | null; created_at: string; seq: number;
  tags?: Record<string, string> | null;
}): string {
  const leg = (l: PayloadLeg) => ({
    account: l.account, side: l.side, amount: l.amount, memo: l.memo ?? null,
    ...(l.tax_code    ? { tax_code:    l.tax_code }    : {}),
    ...(l.tax_amount  ? { tax_amount:  l.tax_amount }  : {}),
    ...(l.fx_currency ? { fx_currency: l.fx_currency } : {}),
    ...(l.fx_amount   ? { fx_amount:   l.fx_amount }   : {}),
  });
  return canonical({
    id: e.id, date: e.date, description: e.description,
    legs: e.legs.map(leg),
    declared_total: e.declared_total,
    claimed_actor: e.claimed_actor,
    idempotency_key: e.idempotency_key,
    created_at: e.created_at, seq: e.seq,
    ...(e.tags && Object.keys(e.tags).length ? { tags: e.tags } : {}),
  });
}

const nowIso = () => new Date().toISOString();

/** The day before an ISO date — used to take an opening snapshot for period reports. */
const prevDay = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** An `in_progress` claim older than this is treated as crash wreckage and can be reclaimed by a fresh attempt */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * When debits and credits don't balance, diagnose the likely error using
 * the old tricks of the accounting trade.
 *
 * These rules have sat in accounting textbooks for a century — bookkeepers
 * used them to find errors by hand. They go into the error message because
 * whatever reads that message is a caller that will act on it: telling it
 * "the difference is divisible by 9, check whether you wrote 54 as 45" is
 * far more useful than telling it "unbalanced entry".
 */
function diagnoseImbalance(
  diffMinor: bigint,
  legs: Array<{ account: string; side: Side; minor: bigint }>,
  currency: Currency,
): string[] {
  const out: string[] = [];
  const abs = diffMinor < 0n ? -diffMinor : diffMinor;
  if (abs === 0n) return out;
  const fmt = (m: bigint) => Money.ofMinor(m, currency).format();

  // The "divide by 2" rule: the difference is exactly twice some leg's
  // amount → that leg is on the wrong side. Flipping an X-amount leg moves
  // X from one side to the other, so the total difference is 2X.
  const half = abs % 2n === 0n ? abs / 2n : null;
  if (half !== null) {
    const flipped = legs.find((l) => l.minor === half);
    if (flipped) {
      out.push(
        `the ${fmt(half)} leg on ${flipped.account} is probably on the wrong side ` +
        `(it is currently "${flipped.side}"); flipping one leg shifts the balance by twice its amount`,
      );
    }
  }

  // The difference exactly equals some leg's amount → its counterpart leg
  // was probably left out
  const missing = legs.find((l) => l.minor === abs);
  if (missing) {
    out.push(
      `the difference equals the ${fmt(abs)} leg on ${missing.account} exactly — ` +
      `its counterpart leg is probably missing`,
    );
  }

  // A leg, adjusted up or down by the difference, exactly matches a leg on
  // the opposite side → that one was almost certainly mis-entered. This is
  // the most common error in practice and the easiest to pin down: two
  // numbers that should have been equal, and one of them got fat-fingered.
  for (const l of legs) {
    const opposite = legs.filter((o) => o.side !== l.side);
    for (const cand of [l.minor + abs, l.minor - abs]) {
      if (cand <= 0n) continue;
      if (opposite.some((o) => o.minor === cand)) {
        out.push(
          `the ${fmt(l.minor)} leg on ${l.account} would be ${fmt(cand)} if it matched the ` +
          `opposite side — check that amount against the source document first`,
        );
        break;
      }
    }
    if (out.length >= 3) break;
  }

  // The "divide by 9" rule: the difference is divisible by 9 → the classic
  // signature of a transposition error (54 typed as 45). Swapping any two
  // digits always produces a difference that's a multiple of 9 — that's a
  // property of base-10, not a coincidence.
  if (abs % 9n === 0n) {
    out.push(
      `the difference ${fmt(abs)} is divisible by 9, which is the classic signature of a ` +
      `transposition error — two digits swapped somewhere (e.g. 54 typed as 45). Re-read each amount against the source document`,
    );
  }

  // The difference is a multiple of a high power of 10 → a misplaced decimal point
  if (abs % 10n === 0n && abs >= 100n) {
    const scaled = legs.find((l) => l.minor * 10n === abs + l.minor || l.minor * 9n === abs);
    if (scaled) {
      out.push(
        `the difference is consistent with a decimal-place slip on the ${fmt(scaled.minor)} leg ` +
        `(${scaled.account}) — check whether it should be 10× larger or smaller`,
      );
    }
  }

  if (!out.length) {
    out.push(
      `no classic error signature matched. Re-add both sides from the source document; ` +
      `debits total ${fmt(legs.filter((l) => l.side === 'debit').reduce((s, l) => s + l.minor, 0n))}, ` +
      `credits total ${fmt(legs.filter((l) => l.side === 'credit').reduce((s, l) => s + l.minor, 0n))}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------

export class Ledger {
  private readonly db: DatabaseSync;
  readonly path: string;
  readonly currency: Currency;
  readonly bookName: string;
  /** Directory where original documents are archived, a sibling of the book file */
  readonly docsDir: string;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
    const meta = this.readMeta();
    this.currency = currencyOf(meta.currency ?? 'SGD');
    this.bookName = meta.book_name ?? '(unnamed)';
    this.docsDir = join(dirname(resolve(path)), 'documents');
  }

  // -- Lifecycle ------------------------------------------------------------

  static create(path: string, opts: { name: string; currency: string }): Ledger {
    if (existsSync(path)) {
      throw err('BOOK_EXISTS', `book already exists at ${path}`,
        'Pick a different path, or open the existing book instead of creating it.');
    }
    const cur = currencyOf(opts.currency);
    const db = new DatabaseSync(path);
    db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
    const ins = db.prepare('INSERT INTO meta (key,value) VALUES (?,?)');
    ins.run('book_name', opts.name);
    ins.run('currency', cur.code);
    ins.run('currency_decimals', String(cur.decimals));
    ins.run('schema_version', String(CURRENT_SCHEMA_VERSION));
    ins.run('created_at', nowIso());
    // schema.sql describes v1; everything added since lives in migrations, so
    // a fresh book runs them too rather than keeping two copies of each table.
    db.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
    migrate(db);
    return new Ledger(db, path);
  }

  static open(path: string): Ledger {
    if (!existsSync(path)) {
      throw err('BOOK_NOT_FOUND', `no book at ${path}`,
        `Create one first: postledger init ${path} --name "..." --currency SGD`);
    }
    const db = new DatabaseSync(path);
    // PRAGMAs are connection-scoped and must be reset on every open, or foreign keys are effectively off
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    // A book outlives the code that wrote it. Bring it forward on open —
    // additive and idempotent, so this is safe to run every time.
    migrate(db);
    return new Ledger(db, path);
  }

  close(): void { this.db.close(); }

  private readMeta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT key,value FROM meta').all() as any[]) {
      out[r.key] = r.value;
    }
    return out;
  }

  // -- Accounts ----------------------------------------------------------------

  openAccount(id: string, type: AccountType, opts: { allowNegative?: boolean; note?: string } = {}) {
    const existing = this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
    if (existing) {
      throw err('ACCOUNT_EXISTS', `account ${id} already exists`,
        'Use the existing account; opening is a one-time action.');
    }
    // Default the overdraft policy by account type rather than blanket-denying.
    // A cash or bank account going negative is almost always an error worth
    // stopping. Income, expense, liability and equity accounts legitimately
    // swing negative — a refund larger than the period's spend, a reversal
    // landing before the entry it corrects. Denying those by default would
    // block correct bookkeeping in the name of a guardrail, which is the trap
    // the reference implementation fell into.
    const allowNegative = opts.allowNegative ?? (type !== 'asset');
    try {
      this.db.prepare(
        'INSERT INTO accounts (id,type,allow_negative,opened_at,note) VALUES (?,?,?,?,?)',
      ).run(id, type, allowNegative ? 1 : 0, nowIso().slice(0, 10), opts.note ?? null);
    } catch (e: any) {
      if (/Colon:Separated/.test(e.message)) {
        throw err('BAD_ACCOUNT_NAME', e.message.replace(/^.*postledger: /, ''),
          'Use a colon-separated path with no spaces, e.g. "Assets:Bank:Checking".');
      }
      throw e;
    }
    return { ok: true as const, account: id, type, allow_negative: allowNegative };
  }

  accounts(): Array<{ id: string; type: string; balance: string }> {
    return (this.db.prepare(`
      SELECT a.id, a.type, COALESCE(b.balance,0) AS balance
      FROM accounts a LEFT JOIN v_balances b ON b.account_id = a.id
      WHERE a.closed_at IS NULL ORDER BY a.id`).all() as any[])
      .map((r) => ({ id: r.id, type: r.type, balance: Money.ofMinor(BigInt(r.balance), this.currency).format() }));
  }

  /** When an account name is wrong, give the model a "did you mean this" */
  private suggestAccounts(wrong: string): string[] {
    const all = (this.db.prepare('SELECT id FROM accounts WHERE closed_at IS NULL').all() as any[]).map((r) => r.id);
    const lower = wrong.toLowerCase();
    const scored = all.map((id) => {
      const a = id.toLowerCase();
      let score = 0;
      if (a === lower) score = 100;
      else if (a.startsWith(lower) || lower.startsWith(a)) score = 50;
      else {
        // number of shared prefix segments
        const as = a.split(':'), ls = lower.split(':');
        let i = 0; while (i < as.length && i < ls.length && as[i] === ls[i]) i++;
        score = i * 10;
        // similar last segment
        if (as.at(-1) && ls.at(-1) && as.at(-1)!.slice(0, 3) === ls.at(-1)!.slice(0, 3)) score += 5;
      }
      return { id, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map((s) => s.id);
  }

  // -- Idempotency ----------------------------------------------------------------

  /**
   * Claim an idempotency key. **Claim first, then do the work** — the claim
   * itself is the atomic operation, so there is no check-then-act window.
   *
   * Returns null if the claim succeeded (proceed with the work); returns an
   * object if this is a replay.
   */
  private claim(key: string, operation: string, requestHash: string):
    { replayed: true; response: any } | null {
    try {
      this.db.prepare(
        'INSERT INTO idempotency (key,operation,request_hash,status,claimed_at) VALUES (?,?,?,?,?)',
      ).run(key, operation, requestHash, 'in_progress', nowIso());
      return null;
    } catch (e: any) {
      if (!/UNIQUE|PRIMARY/i.test(e.message)) throw e;
    }

    const row = this.db.prepare('SELECT * FROM idempotency WHERE key = ?').get(key) as any;

    if (row.request_hash !== requestHash) {
      throw err('IDEMPOTENCY_CONFLICT',
        `idempotency key ${JSON.stringify(key)} was already used with different arguments`,
        'A key is bound to one exact request. If you changed anything — an amount, a date, ' +
        'an account — use a NEW key. Only retry with the same key when the arguments are byte-identical.',
        { previous_operation: row.operation, previous_status: row.status });
    }

    if (row.status === 'completed') {
      return { replayed: true, response: JSON.parse(row.response) };
    }

    if (row.status === 'failed') {
      // The same request failed last time — allow one more attempt
      this.db.prepare('DELETE FROM idempotency WHERE key = ?').run(key);
      return this.claim(key, operation, requestHash);
    }

    // in_progress: could be genuine concurrency, or a previous crash mid-flight
    const age = Date.now() - Date.parse(row.claimed_at);
    if (age > STALE_CLAIM_MS) {
      this.db.prepare('DELETE FROM idempotency WHERE key = ?').run(key);
      return this.claim(key, operation, requestHash);
    }
    throw err('IDEMPOTENCY_IN_PROGRESS',
      `idempotency key ${JSON.stringify(key)} is currently being processed`,
      'The same request is already running. Wait and read the result instead of retrying; ' +
      'retrying now would not create a duplicate, but it will not help either.',
      { claimed_at: row.claimed_at });
  }

  private settle(key: string, response: any): void {
    this.db.prepare(
      'UPDATE idempotency SET status=?, response=?, completed_at=? WHERE key=?',
    ).run('completed', JSON.stringify(response), nowIso(), key);
  }

  private markFailed(key: string, message: string): void {
    try {
      this.db.prepare('UPDATE idempotency SET status=?, error=?, completed_at=? WHERE key=?')
        .run('failed', message.slice(0, 1000), nowIso(), key);
    } catch { /* recording the failure must not itself throw */ }
  }

  // -- Posting ----------------------------------------------------------------

  post(input: PostInput, opts: { dryRun?: boolean } = {}) {
    const key = (input.idempotencyKey ?? '').trim();
    if (!key) {
      throw err('MISSING_IDEMPOTENCY_KEY', 'idempotency_key is required',
        'Derive a stable key from the real-world event you are recording — an invoice number, ' +
        'a bank reference, a webhook id. Same event = same key, so a retry is a safe no-op.');
    }
    if (!ISO_DATE.test(input.date)) {
      throw err('BAD_DATE', `date ${JSON.stringify(input.date)} is not YYYY-MM-DD`,
        'Use an ISO date like "2026-08-08". Do not send "today", "Aug 8", or "2026/8/8".');
    }
    if (!input.description?.trim()) {
      throw err('MISSING_DESCRIPTION', 'description is required',
        'Describe what actually happened, from the source document. Do not invent one.');
    }
    if (!Array.isArray(input.legs) || input.legs.length < 2) {
      throw err('TOO_FEW_LEGS', 'an entry needs at least 2 legs',
        'Double-entry means every entry has at least one debit and one credit.');
    }

    // Validation happens before the claim.
    //
    // Validation is purely read-only — when a request is judged invalid, it
    // was never accepted in the first place, so it must not consume the
    // idempotency key. Otherwise you get this trap: a model submits
    // "invoice-123", gets rejected for a wrong amount, fixes it and retries
    // with the same "invoice-123" (which, to it, is the same real-world
    // event) — and hits IDEMPOTENCY_CONFLICT. The key is reserved for
    // operations that have already started producing side effects, not for
    // typos.
    const validated = this.validate(input);

    // A dry run performs the real write — every trigger, every constraint —
    // and then rolls it back. Simulating the checks instead would mean a second
    // implementation of them, and the second implementation is the one that
    // drifts. It also never touches the idempotency table, so previewing does
    // not consume the key the real call will need.
    if (opts.dryRun) {
      this.db.exec('SAVEPOINT preview');
      try {
        const result = this.write(input, validated);
        return {
          ...result, dry_run: true, replayed: false,
          ids_are_preview_only: true,
          note: 'Nothing was written. The entry_id and chain_head above belong to a rolled-back ' +
                'transaction — do not reuse them. Re-send without dry_run to commit.',
        };
      } finally {
        this.db.exec('ROLLBACK TO preview');
        this.db.exec('RELEASE preview');
      }
    }

    const requestHash = sha256(canonical({ op: 'post', input }));
    const replay = this.claim(key, 'post', requestHash);
    if (replay) return { ...replay.response, replayed: true };

    try {
      const result = this.write(input, validated);
      this.settle(key, result);
      return { ...result, replayed: false };
    } catch (e: any) {
      this.markFailed(key, e.message);
      throw e;
    }
  }

  /** Purely read-only validation. Any failure here means "this request is invalid", not "this attempt failed". */
  private validate(input: PostInput) {
    // Parse amounts into integer minor units first — any float or ambiguity gets rejected right here
    const legs = input.legs.map((l, i) => {
      let amount: Money;
      try {
        amount = Money.fromJson(l.amount, this.currency);
      } catch (e: any) {
        throw err('BAD_AMOUNT', `leg ${i + 1} (${l.account}): ${e.message}`,
          'Send amounts as decimal strings with the right number of decimals, e.g. "1200.00".');
      }
      if (!amount.isPositive()) {
        throw err('NON_POSITIVE_AMOUNT', `leg ${i + 1} (${l.account}) is ${amount.format()}`,
          'Leg amounts are always positive. Express direction with side: "debit" or "credit", not a minus sign.');
      }
      if (l.side !== 'debit' && l.side !== 'credit') {
        throw err('BAD_SIDE', `leg ${i + 1} has side ${JSON.stringify(l.side)}`,
          'side must be exactly "debit" or "credit".');
      }
      let taxMinor: bigint | undefined;
      if (l.taxAmount !== undefined) {
        try { taxMinor = Money.fromJson(l.taxAmount, this.currency).minor; }
        catch (e: any) {
          throw err('BAD_AMOUNT', `leg ${i + 1} tax_amount: ${e.message}`,
            'Tax amounts follow the same rule as every other figure here: a decimal string.');
        }
      }
      // Normalise the FX figure to minor units HERE, once. The hash payload and
      // the row that gets written must be fed the same value — feeding one a
      // decimal string and the other an integer is how a hash silently stops
      // matching its own row. Sharing the payload function is not enough if the
      // inputs differ.
      let fxMinor: bigint | undefined;
      if (l.fxCurrency !== undefined || l.fxAmount !== undefined) {
        if (l.fxCurrency === undefined || l.fxAmount === undefined) {
          throw err('BAD_AMOUNT', `leg ${i + 1}: fx_currency and fx_amount must be given together`,
            'An original amount without its currency, or a currency without an amount, records nothing usable.');
        }
        let fxCur;
        try { fxCur = currencyOf(l.fxCurrency); } catch {
          throw err('BAD_AMOUNT', `leg ${i + 1} fx_currency ${JSON.stringify(l.fxCurrency)} is not a known currency code`,
            'Use an ISO 4217 code such as "EUR". This records what the amount was converted FROM.');
        }
        try { fxMinor = Money.fromJson(l.fxAmount, fxCur).minor; }
        catch (e: any) {
          throw err('BAD_AMOUNT', `leg ${i + 1} fx_amount: ${e.message}`,
            'Original amounts follow the same rule as every other figure: a decimal string.');
        }
      }
      return { ...l, money: amount, taxMinor, fxMinor };
    });

    // Accounts must already exist. When one is wrong, offer candidates instead of making the model guess.
    for (const l of legs) {
      const found = this.db.prepare('SELECT id, closed_at FROM accounts WHERE id = ?').get(l.account) as any;
      if (!found) {
        throw err('UNKNOWN_ACCOUNT', `account ${JSON.stringify(l.account)} does not exist`,
          'Use an existing account from postledger_chart, or open it explicitly first. Never post to an invented account.',
          { did_you_mean: this.suggestAccounts(l.account) });
      }
      if (found.closed_at) {
        throw err('CLOSED_ACCOUNT', `account ${l.account} was closed on ${found.closed_at}`,
          'Pick an open account, or reopen this one deliberately.');
      }
    }

    // Debit/credit balance — recomputed here only to produce a good error message; the DB trigger is the real gatekeeper
    const debits = legs.filter((l) => l.side === 'debit').reduce((s, l) => s.add(l.money), Money.zero(this.currency));
    const credits = legs.filter((l) => l.side === 'credit').reduce((s, l) => s.add(l.money), Money.zero(this.currency));
    if (!debits.equals(credits)) {
      const diff = debits.subtract(credits);
      // Don't just say "unbalanced" — diagnose the **likely error** using
      // the old tricks of the accounting trade. A caller that will act on
      // the message gets far more value from "the difference is divisible
      // by 9, check whether you wrote 54 as 45" than from "unbalanced
      // entry".
      const diagnosis = diagnoseImbalance(diff.minor, legs.map((l) => ({ account: l.account, side: l.side, minor: l.money.minor })), this.currency);
      throw err('UNBALANCED',
        `debits ${debits.format()} != credits ${credits.format()} (off by ${diff.format()})`,
        `The two sides must be equal. You are off by ${diff.abs().format()} on the ` +
        `${diff.isPositive() ? 'debit' : 'credit'} side.` +
        (diagnosis.length ? ' Most likely cause: ' + diagnosis[0] : ' Check for a missing leg or a wrong amount.'),
        { total_debits: debits.format(), total_credits: credits.format(),
          difference: diff.format(), likely_causes: diagnosis });
    }

    // Redundant declared-total cross-check: the caller's self-reported
    // total must match the sum of the legs. LLM errors are almost never
    // self-consistent — a hallucinated line rarely comes with a total that
    // happens to still balance.
    let expected: Money;
    try {
      expected = Money.fromJson(input.expectedTotal, this.currency);
    } catch (e: any) {
      throw err('BAD_EXPECTED_TOTAL', e.message,
        'expected_total is the sum of the debit side, as a decimal string.');
    }
    if (!expected.equals(debits)) {
      throw err('EXPECTED_TOTAL_MISMATCH',
        `expected_total ${expected.format()} != actual debit total ${debits.format()}`,
        'Recount the legs. Either a line is missing/duplicated, or your total is wrong. ' +
        'This gate exists precisely to catch that before it reaches the books.',
        { expected: expected.format(), actual: debits.format(),
          legs: legs.map((l) => `${l.account} ${l.side} ${l.money.format()}`) });
    }

    // Optional stronger assertion: what a given account's balance should be after this entry posts (catches "wrong account" / "wrong direction")
    if (input.expectBalanceAfter) {
      const { account, balance } = input.expectBalanceAfter;
      const want = Money.fromJson(balance, this.currency);
      const current = this.balanceOf(account);
      const delta = legs.filter((l) => l.account === account).reduce((s, l) => {
        const acct = this.db.prepare('SELECT type FROM accounts WHERE id=?').get(account) as any;
        const normalDebit = acct.type === 'asset' || acct.type === 'expense';
        const increases = (normalDebit && l.side === 'debit') || (!normalDebit && l.side === 'credit');
        return increases ? s.add(l.money) : s.subtract(l.money);
      }, Money.zero(this.currency));
      const after = current.add(delta);
      if (!after.equals(want)) {
        throw err('BALANCE_ASSERTION_FAILED',
          `${account} would be ${after.format()} after this entry, not ${want.format()}`,
          'Either the entry is wrong (wrong account or wrong side), or your expected balance is stale. ' +
          'Read the current balance first, then decide.',
          { account, current: current.format(), would_be: after.format(), asserted: want.format() });
      }
    }

    return { legs, debits };
  }

  /**
   * Write: legs land first, sealing happens after.
   * At the moment of sealing, a database trigger validates the whole entry
   * — the validate() above exists only to produce a good error; the real
   * gatekeeper lives in schema.sql.
   */
  private write(input: PostInput, v: ReturnType<Ledger['validate']>) {
    const { legs, debits } = v;
    const id = 'e_' + randomUUID().replace(/-/g, '').slice(0, 20);
    const prev = this.db.prepare('SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1').get() as any;
    const seq = prev ? Number(prev.seq) + 1 : 1;
    const prevHash: string | null = prev ? prev.hash : null;
    const createdAt = nowIso();

    const payload = entryPayload({
      id, date: input.date, description: input.description,
      legs: legs.map((l) => ({
        account: l.account, side: l.side, amount: l.money.minor.toString(), memo: l.memo ?? null,
        tax_code: l.taxCode ?? null,
        tax_amount: l.taxMinor !== undefined ? l.taxMinor.toString() : null,
        fx_currency: l.fxCurrency ?? null,
        fx_amount: l.fxMinor !== undefined ? l.fxMinor.toString() : null,
      })),
      declared_total: debits.minor.toString(),
      claimed_actor: input.actor ?? null,
      idempotency_key: input.idempotencyKey,
      created_at: createdAt, seq,
      tags: input.tags ?? null,
    });
    const hash = sha256((prevHash ?? '') + payload);

    // Already inside a savepoint (a dry run) means a transaction is open, and
    // SQLite has no nested BEGIN.
    const inTx = this.db.isTransaction === true;
    if (!inTx) this.db.exec('BEGIN IMMEDIATE');
    try {
      const insLeg = this.db.prepare(
        `INSERT INTO postings (entry_id,seq,account_id,side,amount,memo,tax_code,tax_amount,fx_currency,fx_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?)`);
      legs.forEach((l, i) => insLeg.run(id, i + 1, l.account, l.side, l.money.minor, l.memo ?? null,
        l.taxCode ?? null, l.taxMinor ?? null, l.fxCurrency ?? null, l.fxMinor ?? null));

      this.db.prepare(`INSERT INTO entries
        (id,date,description,declared_total,declared_legs,claimed_actor,idempotency_key,
         created_at,prev_hash,hash,seq,tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.date, input.description, debits.minor, BigInt(legs.length),
             input.actor ?? null, input.idempotencyKey, createdAt, prevHash, hash, BigInt(seq),
             input.tags && Object.keys(input.tags).length ? canonical(input.tags) : null);

      this.db.prepare('INSERT INTO chain_head (seq,hash,recorded_at) VALUES (?,?,?)')
        .run(BigInt(seq), hash, createdAt);

      if (!inTx) this.db.exec('COMMIT');
    } catch (e: any) {
      if (!inTx) this.db.exec('ROLLBACK');
      if (/below zero/.test(e.message)) {
        throw err('WOULD_GO_NEGATIVE', e.message.replace(/^.*postledger: /, ''),
          'That account is marked as not allowing a negative balance — a cash or bank account ' +
          'going negative is usually a missing entry rather than an overdraft. Check the balance ' +
          'first, or open the account with allow_negative if it genuinely may go below zero.');
      }
      if (/lock date|closed period/.test(e.message)) {
        throw err('PERIOD_LOCKED', e.message.replace(/^.*postledger: /, ''),
          'That period has been closed. Post to an open period, or reopen the closed one deliberately — ' +
          'reopening is recorded, which is the point.');
      }
      throw err('WRITE_REJECTED', e.message.replace(/^.*postledger: /, ''),
        'The database refused this entry. This is the last line of defence — the message says which invariant failed.');
    }

    return {
      ok: true as const,
      entry_id: id, seq, date: input.date, description: input.description,
      total: debits.format(), currency: this.currency.code,
      legs: legs.map((l) => ({ account: l.account, side: l.side, amount: l.money.format(),
        ...(l.taxCode ? { tax_code: l.taxCode } : {}),
        ...(l.taxMinor !== undefined ? { tax_amount: Money.ofMinor(l.taxMinor, this.currency).format() } : {}),
        ...(l.fxCurrency && l.fxMinor !== undefined
            ? { fx_currency: l.fxCurrency, fx_amount: Money.ofMinor(l.fxMinor, currencyOf(l.fxCurrency)).format() } : {}) })),
      ...(input.tags && Object.keys(input.tags).length ? { tags: input.tags } : {}),
      // The chain head is returned on every write. In the MCP setting it
      // automatically ends up in the conversation transcript — an external
      // witness the operator cannot themselves edit.
      chain_head: hash,
    };
  }

  // -- Reversal ----------------------------------------------------------------

  reverse(entryId: string, opts: { idempotencyKey: string; reason: string; date?: string; actor?: string }) {
    const original = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    if (!original) {
      throw err('ENTRY_NOT_FOUND', `no entry ${entryId}`, 'List entries first to find the right id.');
    }
    const already = this.db.prepare('SELECT reversing_entry_id FROM reversals WHERE reversed_entry_id = ?').get(entryId) as any;
    if (already) {
      throw err('ALREADY_REVERSED', `entry ${entryId} was already reversed by ${already.reversing_entry_id}`,
        'An entry can only be reversed once. If the reversal itself is wrong, post a fresh correcting entry.');
    }
    const legs = (this.db.prepare('SELECT * FROM postings WHERE entry_id = ? ORDER BY seq').all(entryId) as any[])
      .map((p) => ({
        account: p.account_id,
        side: (p.side === 'debit' ? 'credit' : 'debit') as Side,   // direction flipped
        amount: Money.ofMinor(BigInt(p.amount), this.currency).format(),
        memo: `reversal of ${entryId}`,
      }));
    const total = Money.ofMinor(BigInt(original.declared_total), this.currency).format();

    const result = this.post({
      idempotencyKey: opts.idempotencyKey,
      date: opts.date ?? nowIso().slice(0, 10),
      description: `REVERSAL of ${entryId}: ${opts.reason}`,
      legs, expectedTotal: total, actor: opts.actor,
    });

    if (!result.replayed) {
      this.db.prepare('INSERT INTO reversals (reversing_entry_id,reversed_entry_id,reason,created_at) VALUES (?,?,?,?)')
        .run(result.entry_id, entryId, opts.reason, nowIso());
    }
    return { ...result, reversed_entry_id: entryId };
  }

  /**
   * **Fully undo** every entry a given actor has written.
   *
   * This is only possible because the ledger is append-only with per-entry
   * attribution: when an agent goes rogue and posts garbage, or someone
   * points a batch of documents at the wrong book, you don't need to hunt
   * down by hand which accounts it touched, and you don't need to roll the
   * whole book back from backup — just reverse its writes one by one, by
   * signature.
   *
   * Note the word is "reverse", not "delete". The net effect on the books
   * is as if this actor had never written anything, but the history is
   * fully preserved: who wrote it, what it said, when and by whom it was
   * undone, and why. An actual DELETE would defeat the entire point of the
   * audit chain — that is precisely the operation this is meant to avoid.
   *
   * Idempotent down to each entry: the batch key derives a per-entry
   * sub-key (`batch:entry_id`), so if the run is interrupted midway, simply
   * re-running it recognizes already-reversed entries as replays and skips
   * them, converging to completion.
   *
   * Honesty boundary: actor is a value the caller **self-reports** (there
   * is no trusted identity under stdio MCP). This feature is built for
   * accidents — a rogue agent, a colleague who pointed at the wrong book —
   * not for someone deliberately forging a signature.
   */
  revertActor(actor: string, opts: {
    idempotencyKey: string;
    reason: string;
    since?: string;
    until?: string;
    dryRun?: boolean;
  }) {
    if (!actor?.trim()) {
      throw err('MISSING_ACTOR', 'actor is required',
        'Pass the actor string exactly as it appears in the entries (see postledger_list_entries).');
    }
    if (!opts.dryRun && !opts.idempotencyKey?.trim()) {
      throw err('MISSING_IDEMPOTENCY_KEY', 'idempotency_key is required for a bulk revert',
        'Use a stable batch key like "revert-rogue-agent-20260808". Re-running with the same key resumes safely.');
    }

    const where = ['e.claimed_actor = ?'];
    const args: any[] = [actor];
    if (opts.since) { where.push('e.date >= ?'); args.push(opts.since); }
    if (opts.until) { where.push('e.date <= ?'); args.push(opts.until); }

    const targets = this.db.prepare(`
      SELECT e.* FROM entries e
      WHERE ${where.join(' AND ')}
        AND NOT EXISTS (SELECT 1 FROM reversals r WHERE r.reversed_entry_id  = e.id)
        AND NOT EXISTS (SELECT 1 FROM reversals r WHERE r.reversing_entry_id = e.id)
      ORDER BY e.seq
    `).all(...args) as any[];

    const legStmt = this.db.prepare('SELECT * FROM postings WHERE entry_id=? ORDER BY seq');

    // Work out up front how much this batch of reversals would move each
    // account by — this is exactly what dry-run exists to show
    const impact = new Map<string, bigint>();
    for (const t of targets) {
      for (const p of legStmt.all(t.id) as any[]) {
        const acct = this.db.prepare('SELECT type FROM accounts WHERE id=?').get(p.account_id) as any;
        const normalDebit = acct.type === 'asset' || acct.type === 'expense';
        const increases = (normalDebit && p.side === 'debit') || (!normalDebit && p.side === 'credit');
        // A reversal's effect is the opposite of the original entry's
        const delta = increases ? -BigInt(p.amount) : BigInt(p.amount);
        impact.set(p.account_id, (impact.get(p.account_id) ?? 0n) + delta);
      }
    }

    const preview = {
      actor,
      matched: targets.length,
      entries: targets.map((t) => ({
        entry_id: t.id, seq: Number(t.seq), date: t.date, description: t.description,
        total: Money.ofMinor(BigInt(t.declared_total), this.currency).format(),
      })),
      balance_impact: [...impact.entries()].map(([account, delta]) => ({
        account,
        change: Money.ofMinor(delta, this.currency).format(),
        after: Money.ofMinor(this.balanceOf(account).minor + delta, this.currency).format(),
      })),
      currency: this.currency.code,
    };

    if (opts.dryRun) {
      return { ok: true as const, dry_run: true, ...preview,
        note: targets.length === 0
          ? `No un-reversed entries by ${JSON.stringify(actor)}. Nothing would change.`
          : `Would post ${targets.length} reversing entries. Re-run without --dry-run to apply.` };
    }

    // How many entries this batch has already reversed in a prior run.
    // On a re-run, targets will be empty (already-reversed ones are
    // excluded), and if we only reported reverted: 0, the caller couldn't
    // tell "already fully applied" apart from "never took effect at all" —
    // so this count is reported alongside it.
    const priorBatch = Number((this.db.prepare(
      "SELECT COUNT(*) c FROM idempotency WHERE key LIKE ? AND status='completed'",
    ).get(opts.idempotencyKey.replace(/[%_]/g, '') + ':%') as any).c);

    const done: any[] = [];
    for (const t of targets) {
      const r = this.reverse(t.id, {
        idempotencyKey: `${opts.idempotencyKey}:${t.id}`,
        reason: `${opts.reason} [bulk revert of actor ${actor}, batch ${opts.idempotencyKey}]`,
        actor: 'postledger:revert-actor',
      });
      done.push({ reversed: t.id, reversing: r.entry_id, replayed: r.replayed });
    }

    const fresh = done.filter((d) => !d.replayed).length;
    return {
      ok: true as const, dry_run: false, actor,
      reverted: fresh,
      already_done: priorBatch + done.filter((d) => d.replayed).length,
      reversals: done,
      balance_impact: preview.balance_impact,
      note: fresh === 0 && priorBatch > 0
        ? `Nothing new to revert — batch ${JSON.stringify(opts.idempotencyKey)} already reversed ` +
          `${priorBatch} entr${priorBatch === 1 ? 'y' : 'ies'} by ${JSON.stringify(actor)}. The books are unchanged.`
        : fresh === 0
          ? `No un-reversed entries by ${JSON.stringify(actor)}. Nothing changed.`
          : `Reverted ${fresh} entr${fresh === 1 ? 'y' : 'ies'} by ${JSON.stringify(actor)}.`,
      chain_head: this.anchor().hash,
    };
  }

  /** What entries a given actor has written — the first question when something goes wrong */
  entriesByActor(actor: string, opts: { limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`
      SELECT e.*, EXISTS(SELECT 1 FROM reversals r WHERE r.reversed_entry_id = e.id) AS reversed
      FROM entries e WHERE e.claimed_actor = ? ORDER BY e.seq DESC LIMIT ?`).all(actor, limit) as any[];
    return {
      ok: true as const, actor, count: rows.length,
      entries: rows.map((r) => ({
        entry_id: r.id, seq: Number(r.seq), date: r.date, description: r.description,
        total: Money.ofMinor(BigInt(r.declared_total), this.currency).format(),
        reversed: Number(r.reversed) === 1,
      })),
    };
  }

  /** Which actors have appeared in the book — the entry point for incident triage */
  actors() {
    const rows = this.db.prepare(`
      SELECT COALESCE(claimed_actor,'(unsigned)') AS actor, COUNT(*) n,
             MIN(date) first_date, MAX(date) last_date
      FROM entries GROUP BY claimed_actor ORDER BY n DESC`).all() as any[];
    return {
      ok: true as const,
      actors: rows.map((r) => ({ actor: r.actor, entries: Number(r.n), first: r.first_date, last: r.last_date })),
      note: 'actor is self-declared, not verified. Useful for accidents, not for adversaries.',
    };
  }

  // -- Queries ----------------------------------------------------------------

  balanceOf(account: string): Money {
    const row = this.db.prepare('SELECT balance FROM v_balances WHERE account_id = ?').get(account) as any;
    if (!row) {
      throw err('UNKNOWN_ACCOUNT', `account ${JSON.stringify(account)} does not exist`,
        'Use postledger_chart to see the available accounts.',
        { did_you_mean: this.suggestAccounts(account) });
    }
    return Money.ofMinor(BigInt(row.balance), this.currency);
  }

  balance(account: string, opts: { asOf?: string; subtree?: boolean } = {}) {
    if (!opts.asOf && !opts.subtree) {
      return { ok: true as const, account, balance: this.balanceOf(account).format(), currency: this.currency.code };
    }
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account)) {
      throw err('UNKNOWN_ACCOUNT', `account ${JSON.stringify(account)} does not exist`,
        'Use postledger_chart to see the available accounts.',
        { did_you_mean: this.suggestAccounts(account) });
    }
    const asOf = opts.asOf ?? nowIso().slice(0, 10);
    const bal = this.balanceUpTo(account, asOf, opts.subtree ?? false);
    return { ok: true as const, account, balance: Money.ofMinor(bal, this.currency).format(),
             as_of: asOf, subtree: opts.subtree ?? false, currency: this.currency.code };
  }

  /** Roll up by prefix, e.g. prefix="Expenses" gets every expense account */
  balanceTree(prefix = '') {
    const rows = this.db.prepare(
      'SELECT account_id, type, balance FROM v_balances WHERE account_id LIKE ? ORDER BY account_id',
    ).all(prefix ? prefix + '%' : '%') as any[];
    const total = rows.reduce((s, r) => s + BigInt(r.balance), 0n);
    return {
      ok: true as const,
      prefix: prefix || '(all)',
      accounts: rows.map((r) => ({
        account: r.account_id, type: r.type,
        balance: Money.ofMinor(BigInt(r.balance), this.currency).format(),
      })),
      total: Money.ofMinor(total, this.currency).format(),
      currency: this.currency.code,
    };
  }

  trialBalance() {
    const tb = this.db.prepare('SELECT * FROM v_trial_balance').get() as any;
    const debits = Money.ofMinor(BigInt(tb.total_debits), this.currency);
    const credits = Money.ofMinor(BigInt(tb.total_credits), this.currency);
    const rows = this.db.prepare('SELECT account_id, type, balance FROM v_balances ORDER BY account_id').all() as any[];
    return {
      ok: true as const,
      balanced: debits.equals(credits),
      total_debits: debits.format(),
      total_credits: credits.format(),
      currency: this.currency.code,
      accounts: rows.map((r) => ({
        account: r.account_id, type: r.type,
        balance: Money.ofMinor(BigInt(r.balance), this.currency).format(),
      })),
    };
  }

  /**
   * Account balances as of a date, recomputed from postings rather than read
   * from a cache — reports must be reproducible from the journal or they are
   * not worth printing.
   */
  private balanceRows(asOf?: string): BalanceRow[] {
    const sql = asOf
      ? `SELECT a.id AS account_id, a.type,
           COALESCE(SUM(CASE WHEN a.type IN ('asset','expense')
             THEN CASE WHEN p.side='debit'  THEN p.amount ELSE -p.amount END
             ELSE CASE WHEN p.side='credit' THEN p.amount ELSE -p.amount END END), 0) AS balance
         FROM accounts a
         LEFT JOIN postings p ON p.account_id = a.id
         LEFT JOIN entries  e ON e.id = p.entry_id
         WHERE e.id IS NULL OR e.date <= ?
         GROUP BY a.id, a.type`
      : 'SELECT account_id, type, balance FROM v_balances';
    const rows = (asOf ? this.db.prepare(sql).all(asOf) : this.db.prepare(sql).all()) as any[];
    return rows.map((r) => ({ account: r.account_id, type: r.type, balance: BigInt(r.balance) }));
  }

  /** Balance sheet. Asserts the accounting identity instead of assuming it. */
  balanceSheet(asOf?: string) {
    return balanceSheet(this.balanceRows(asOf), this.currency, asOf);
  }

  /**
   * Income statement for a period.
   *
   * Income and expense balances are cumulative in the journal, so a bounded
   * period is computed as (balances up to `to`) minus (balances before `from`).
   */
  incomeStatement(period: { from?: string; to?: string } = {}) {
    const upTo = this.balanceRows(period.to);
    if (!period.from) return incomeStatement(upTo, this.currency, period);

    const before = new Map(
      this.balanceRows(prevDay(period.from)).map((r) => [r.account, r.balance]),
    );
    const delta = upTo.map((r) => ({ ...r, balance: r.balance - (before.get(r.account) ?? 0n) }));
    return incomeStatement(delta, this.currency, period);
  }

  /** Export the whole book as a hledger/ledger journal. Your data, portable. */
  exportJournal(opts: { includeTags?: boolean } = {}) {
    const rows = this.db.prepare('SELECT * FROM entries ORDER BY seq').all() as any[];
    const legStmt = this.db.prepare('SELECT * FROM postings WHERE entry_id=? ORDER BY seq');
    const entries: ExportEntry[] = rows.map((r) => ({
      date: r.date,
      description: r.description,
      entry_id: r.id,
      idempotency_key: r.idempotency_key ?? undefined,
      actor: r.claimed_actor,
      legs: (legStmt.all(r.id) as any[]).map((p) => ({
        account: p.account_id, side: p.side, amount: BigInt(p.amount), memo: p.memo,
      })),
    }));
    return toJournal(entries, this.currency, { ...opts, bookName: this.bookName });
  }

  /**
   * Import a hledger/ledger journal.
   *
   * Every transaction goes through the normal `post()` path, so imported data
   * is subject to exactly the same invariants as anything an agent writes —
   * an import is not a back door. Idempotency keys are derived from the file
   * name and position, so re-running the same import is a no-op.
   */
  importJournal(text: string, opts: { source: string; actor?: string; dryRun?: boolean }) {
    const parsed = fromJournal(text, this.currency);
    const missing = new Set<string>();
    for (const t of parsed) {
      for (const l of t.legs) {
        if (!this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(l.account)) missing.add(l.account);
      }
    }
    if (missing.size) {
      throw err('UNKNOWN_ACCOUNTS_IN_IMPORT',
        `the journal references ${missing.size} account(s) that do not exist in this book`,
        'Open them first — an import must not silently create a chart of accounts. ' +
        'Review the list, then run `postledger account open` for each one you actually want.',
        { missing: [...missing].sort() });
    }
    if (opts.dryRun) {
      return { ok: true as const, dry_run: true, transactions: parsed.length,
               accounts_referenced: [...new Set(parsed.flatMap((t) => t.legs.map((l) => l.account)))].sort(),
               note: `Would post ${parsed.length} entries. Re-run without --dry-run to apply.` };
    }
    // Derive the idempotency key from the transaction's CONTENT, not its line
    // number. A key containing the row index breaks the moment the file is
    // re-sorted or a line is inserted above — every key shifts, nothing is
    // recognised as a replay, and the whole file posts a second time. That is
    // a hole in the one property this project is built on.
    //
    // Two genuinely distinct transactions can be identical (two 12.00 coffees
    // on the same day), so identical fingerprints are disambiguated by their
    // occurrence within the file. Re-importing the same file reproduces the
    // same fingerprints in the same order, so the count matches and every
    // entry is recognised as a replay.
    const seen = new Map<string, number>();
    const results = parsed.map((t) => {
      const fingerprint = sha256(canonical({
        date: t.date,
        description: t.description,
        legs: t.legs.map((l) => `${l.account}|${l.side}|${l.amount}`).sort(),
      })).slice(0, 16);
      const nth = (seen.get(fingerprint) ?? 0) + 1;
      seen.set(fingerprint, nth);
      return this.post({
        idempotencyKey: `import:${opts.source}:${fingerprint}${nth > 1 ? `#${nth}` : ''}`,
        date: t.date,
        description: t.description,
        legs: t.legs.map((l) => ({ account: l.account, side: l.side, amount: l.amount })),
        expectedTotal: t.expectedTotal,
        actor: opts.actor ?? `import:${opts.source}`,
      });
    });
    return {
      ok: true as const, dry_run: false,
      imported: results.filter((r) => !r.replayed).length,
      already_present: results.filter((r) => r.replayed).length,
      transactions: parsed.length,
      chain_head: this.anchor().hash,
    };
  }

  entries(opts: {
    limit?: number; account?: string; since?: string; until?: string;
    tag?: string; tagValue?: string; describes?: string; actor?: string;
    minAmount?: string; maxAmount?: string; taxCode?: string;
    beforeSeq?: number;
  } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where: string[] = [];
    const args: any[] = [];
    if (opts.account) {
      // Prefix match, so asking for "Expenses" covers every expense account.
      where.push(`EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id
                    AND (p.account_id = ? OR p.account_id LIKE ?))`);
      args.push(opts.account, opts.account + ':%');
    }
    if (opts.since) { where.push('e.date >= ?'); args.push(opts.since); }
    if (opts.until) { where.push('e.date <= ?'); args.push(opts.until); }
    if (opts.actor) { where.push('e.claimed_actor = ?'); args.push(opts.actor); }
    if (opts.describes) {
      where.push("e.description LIKE '%' || ? || '%' ESCAPE '\\'");
      args.push(opts.describes.replace(/[%_\\]/g, (c) => '\\' + c));
    }
    if (opts.tag) {
      // Tags are canonical JSON on the entry, so a substring match on the
      // serialised key (and optionally the value) is exact enough and needs
      // no extra table.
      if (opts.tagValue !== undefined) {
        where.push('e.tags LIKE ?');
        args.push('%' + JSON.stringify(opts.tag) + ':' + JSON.stringify(opts.tagValue) + '%');
      } else {
        where.push('e.tags LIKE ?');
        args.push('%' + JSON.stringify(opts.tag) + ':%');
      }
    }
    if (opts.taxCode) {
      where.push('EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.tax_code = ?)');
      args.push(opts.taxCode);
    }
    if (opts.minAmount) { where.push('e.declared_total >= ?'); args.push(Money.fromJson(opts.minAmount, this.currency).minor); }
    if (opts.maxAmount) { where.push('e.declared_total <= ?'); args.push(Money.fromJson(opts.maxAmount, this.currency).minor); }
    // Cursor paging. seq is monotonic, so "everything before N" is a stable
    // window even while new entries are being written — an offset would shift
    // under you.
    if (opts.beforeSeq !== undefined) { where.push('e.seq < ?'); args.push(BigInt(opts.beforeSeq)); }

    const sql = `SELECT * FROM entries e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY e.seq DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as any[];
    const legStmt = this.db.prepare('SELECT * FROM postings WHERE entry_id=? ORDER BY seq');
    return {
      ok: true as const,
      count: rows.length,
      // Cursor for the next page: pass it back as before_seq. Null means this
      // was the last page, so a caller can walk the whole history without
      // guessing when to stop.
      next_before_seq: rows.length === limit ? Number(rows[rows.length - 1]!.seq) : null,
      entries: rows.map((r) => ({
        entry_id: r.id, seq: Number(r.seq), date: r.date, description: r.description,
        total: Money.ofMinor(BigInt(r.declared_total), this.currency).format(),
        claimed_actor: r.claimed_actor,
        ...(r.tags ? { tags: JSON.parse(r.tags) } : {}),
        legs: (legStmt.all(r.id) as any[]).map((p) => ({
          account: p.account_id, side: p.side,
          amount: Money.ofMinor(BigInt(p.amount), this.currency).format(),
          ...(p.tax_code ? { tax_code: p.tax_code } : {}),
          ...(p.tax_amount != null ? { tax_amount: Money.ofMinor(BigInt(p.tax_amount), this.currency).format() } : {}),
          ...(p.fx_currency ? { fx_currency: p.fx_currency,
                fx_amount: Money.ofMinor(BigInt(p.fx_amount), currencyOf(p.fx_currency)).format() } : {}),
        })),
      })),
    };
  }

  // -- Verification ----------------------------------------------------------------

  /**
   * Three independent checks, all required:
   *   chain     chain is unbroken + chain head matches the chain_head table → entries have not been edited or truncated
   *   balance   recompute and assert from postings                          → derived data has not drifted
   *   documents recompute the on-disk file fingerprints                     → originals have not been swapped out
   *
   * The third is the easiest to skip: storing a sha256 you never check against is the same as not storing it.
   */
  verify(opts: { chain?: boolean; balance?: boolean; documents?: boolean; assertions?: boolean } = {}) {
    const run = { chain: opts.chain !== false, balance: opts.balance !== false,
                  documents: opts.documents !== false, assertions: opts.assertions !== false };
    const problems: Array<{ check: string; problem: string; where?: unknown }> = [];

    if (run.chain) {
      const rows = this.db.prepare('SELECT * FROM entries ORDER BY seq').all() as any[];
      let prev = '';
      for (const r of rows) {
        if ((r.prev_hash ?? '') !== prev) {
          problems.push({ check: 'chain', problem: 'prev_hash does not match the previous entry', where: { seq: Number(r.seq), entry_id: r.id } });
          break;
        }
        const legs = (this.db.prepare('SELECT * FROM postings WHERE entry_id=? ORDER BY seq').all(r.id) as any[])
          .map((p) => ({
            account: p.account_id, side: p.side, amount: BigInt(p.amount).toString(), memo: p.memo ?? null,
            tax_code: p.tax_code ?? null,
            tax_amount: p.tax_amount !== null && p.tax_amount !== undefined ? BigInt(p.tax_amount).toString() : null,
            fx_currency: p.fx_currency ?? null,
            fx_amount: p.fx_amount !== null && p.fx_amount !== undefined ? BigInt(p.fx_amount).toString() : null,
          }));
        const expect = sha256(prev + entryPayload({
          id: r.id, date: r.date, description: r.description, legs,
          declared_total: BigInt(r.declared_total).toString(),
          claimed_actor: r.claimed_actor, idempotency_key: r.idempotency_key,
          created_at: r.created_at, seq: Number(r.seq),
          tags: r.tags ? JSON.parse(r.tags) : null,
        }));
        if (expect !== r.hash) {
          problems.push({ check: 'chain', problem: 'hash does not match the entry contents (tampered or re-written)', where: { seq: Number(r.seq), entry_id: r.id } });
          break;
        }
        prev = r.hash;
      }
      // Truncation check: chain_head records every step taken, so if it's longer than entries, the tail was cut off
      const headMax = this.db.prepare('SELECT MAX(seq) m FROM chain_head').get() as any;
      const entryMax = this.db.prepare('SELECT MAX(seq) m FROM entries').get() as any;
      if (Number(headMax?.m ?? 0) !== Number(entryMax?.m ?? 0)) {
        problems.push({ check: 'chain', problem: 'chain_head is ahead of entries — the chain has been truncated',
          where: { chain_head_max: Number(headMax?.m ?? 0), entries_max: Number(entryMax?.m ?? 0) } });
      }

      // Missing-sequence check: seq must run 1..N with no gaps. The trigger
      // guarantees contiguity at write time, but deleting a middle entry
      // by bypassing the trigger leaves a gap — and this makes it visible
      // at a glance.
      const gaps = this.db.prepare(`
        SELECT ch.seq FROM chain_head ch
        WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.seq = ch.seq)
        ORDER BY ch.seq LIMIT 20`).all() as any[];
      if (gaps.length) {
        problems.push({ check: 'chain',
          problem: `${gaps.length} entr${gaps.length === 1 ? 'y has' : 'ies have'} been deleted from the middle of the chain`,
          where: { missing_seq: gaps.map((g) => Number(g.seq)) } });
      }
    }

    if (run.balance) {
      const tb = this.db.prepare('SELECT * FROM v_trial_balance').get() as any;
      if (BigInt(tb.total_debits) !== BigInt(tb.total_credits)) {
        problems.push({ check: 'balance', problem: 'the books do not balance', where: tb });
      }
      const orphans = this.db.prepare('SELECT COUNT(*) c FROM v_orphan_postings').get() as any;
      if (Number(orphans.c) > 0) {
        problems.push({ check: 'balance', problem: `${orphans.c} unsealed posting(s) left behind by a crashed write`,
          where: { hint: 'safe to delete: they are invisible to all reports' } });
      }
    }

    if (run.documents) {
      const docs = this.db.prepare('SELECT * FROM documents').all() as any[];
      for (const d of docs) {
        const abs = join(this.docsDir, d.rel_path);
        if (!existsSync(abs)) {
          problems.push({ check: 'documents', problem: 'archived file is missing from disk', where: { sha256: d.sha256, path: d.rel_path } });
          continue;
        }
        const actual = sha256(readFileSync(abs));
        if (actual !== d.sha256) {
          problems.push({ check: 'documents', problem: 'archived file has been replaced (fingerprint mismatch)', where: { expected: d.sha256, actual, path: d.rel_path } });
        }
      }
    }

    if (run.assertions) {
      // Re-check every assertion ever recorded against the journal as it
      // stands now. This is the check that looks outward: the others prove the
      // ledger is internally consistent, this one is the only evidence that it
      // still matches what somebody once confirmed against reality.
      //
      // An assertion breaking does NOT mean the assertion is wrong. It means
      // the ledger changed underneath a checkpoint — which for an append-only
      // ledger means an entry was back-dated into a period already confirmed.
      const rows = this.db.prepare('SELECT * FROM assertions ORDER BY seq').all() as any[];
      for (const a of rows) {
        const actual = this.balanceUpTo(a.account, a.date, Number(a.subtree) === 1);
        if (actual !== BigInt(a.amount)) {
          problems.push({
            check: 'assertions',
            problem: `assertion #${Number(a.seq)} no longer holds: ${a.account} was confirmed at ` +
              `${Money.ofMinor(BigInt(a.amount), this.currency).format()} as of ${a.date}, but now ` +
              `recomputes to ${Money.ofMinor(actual, this.currency).format()} — something was ` +
              `posted into a period that had already been confirmed`,
            where: { assertion_seq: Number(a.seq), account: a.account, date: a.date,
                     confirmed: Money.ofMinor(BigInt(a.amount), this.currency).format(),
                     recomputed: Money.ofMinor(actual, this.currency).format() },
          });
        }
      }
    }

    const head = this.db.prepare('SELECT hash, seq FROM entries ORDER BY seq DESC LIMIT 1').get() as any;
    return {
      ok: problems.length === 0,
      checks_run: Object.entries(run).filter(([, v]) => v).map(([k]) => k),
      entries: Number((this.db.prepare('SELECT COUNT(*) c FROM entries').get() as any).c),
      chain_head: head?.hash ?? null,
      chain_length: head ? Number(head.seq) : 0,
      problems,
    };
  }

  /**
   * Check this ledger against its own history of external anchors —
   * "cross-verification".
   *
   * The anchor file is an append-only line record (`seq<TAB>hash<TAB>time`),
   * built up one line at a time via `postledger anchor >> anchors.log`, and
   * kept somewhere else — a git remote, another machine, object storage.
   *
   * Verification method: for every historical anchor, check whether this
   * ledger's hash at that seq position is still the same.
   *   - the position doesn't exist → that stretch of history was deleted
   *   - the hash doesn't match     → history after that point was rewritten
   *
   * This is the only piece of the design that **actually holds up against
   * local root**: an attacker can recompute the entire chain in the
   * database to be perfectly self-consistent, but they cannot reach a copy
   * that has already left this machine. The more scattered the anchors are
   * (a git remote, a colleague's inbox, another host), the more expensive
   * forgery gets.
   */
  verifyAgainstAnchors(anchorsPath: string) {
    if (!existsSync(anchorsPath)) {
      throw err('ANCHORS_NOT_FOUND', `no anchor log at ${anchorsPath}`,
        `Start one: postledger anchor --book ${this.path} >> ${anchorsPath}`);
    }
    const lines = readFileSync(anchorsPath, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    const problems: Array<{ check: string; problem: string; where?: unknown }> = [];
    let checked = 0, matched = 0;

    for (const line of lines) {
      const [seqRaw, hash] = line.split(/\s+/);
      const seq = Number(seqRaw);
      if (!Number.isInteger(seq) || !hash) continue;
      checked++;
      const row = this.db.prepare('SELECT hash FROM entries WHERE seq = ?').get(BigInt(seq)) as any;
      if (!row) {
        problems.push({ check: 'anchors',
          problem: `entry at seq ${seq} is gone, but an external anchor witnessed it`,
          where: { seq, witnessed_hash: hash } });
      } else if (row.hash !== hash) {
        problems.push({ check: 'anchors',
          problem: `entry at seq ${seq} has a different hash than the external anchor — history was rewritten`,
          where: { seq, witnessed: hash, current: row.hash } });
      } else matched++;
    }

    return {
      ok: problems.length === 0,
      anchors_checked: checked,
      anchors_matched: matched,
      problems,
      note: checked === 0
        ? 'The anchor log is empty — it proves nothing yet. Append after each posting session.'
        : `Verified against ${checked} external witness point(s). ` +
          `This is the only check here that a local root user cannot defeat, ` +
          `and only to the extent the anchor log itself lives somewhere they do not control.`,
    };
  }

  /**
   * Ageing for one account: how old is the money sitting there.
   *
   * Reversed entries are excluded — a reversed receivable is cancelled, not
   * overdue, and showing it in the 90+ bucket would be actively misleading.
   */
  ageing(account: string, opts: { asOf?: string } = {}) {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account)) {
      throw err('UNKNOWN_ACCOUNT', `account ${JSON.stringify(account)} does not exist`,
        'Use postledger_chart to see the available accounts.',
        { did_you_mean: this.suggestAccounts(account) });
    }
    const asOf = opts.asOf ?? nowIso().slice(0, 10);
    const acct = this.db.prepare('SELECT type FROM accounts WHERE id = ?').get(account) as any;
    const normalDebit = acct.type === 'asset' || acct.type === 'expense';

    const rows = this.db.prepare(
      `SELECT e.id, e.date, e.description, p.side, p.amount
       FROM postings p JOIN entries e ON e.id = p.entry_id
       WHERE p.account_id = ?
         AND NOT EXISTS (SELECT 1 FROM reversals r WHERE r.reversed_entry_id  = e.id)
         AND NOT EXISTS (SELECT 1 FROM reversals r WHERE r.reversing_entry_id = e.id)
         AND e.date <= ?
       ORDER BY e.date`).all(account, asOf) as any[];

    const items = rows.map((r) => {
      const increases = (normalDebit && r.side === 'debit') || (!normalDebit && r.side === 'credit');
      return { ref: r.id, date: r.date, counterparty: r.description,
               amount: increases ? BigInt(r.amount) : -BigInt(r.amount) };
    }).filter((i) => i.amount !== 0n);

    return { account, ...ageing(items, this.currency, asOf) };
  }

  /**
   * Convert an amount at a stated rate, exactly.
   *
   * For a book kept in one currency, a foreign transaction is recorded at the
   * rate that applied on the day, with the original amount kept alongside as
   * an audit column. That is all "multi-currency" means at the point of entry:
   * one conversion. What is genuinely hard — exchange gain or loss when a
   * receivable settles at a different rate, and period-end revaluation — is
   * about rate *movement*, not conversion, and is deliberately out of scope.
   *
   * The rate is handled as a fraction, never a float, so the result is exact.
   */
  convert(amount: string, from: string, rate: string, opts: { to?: string } = {}) {
    const src = currencyOf(from);
    const dst = opts.to ? currencyOf(opts.to) : this.currency;
    const original = Money.fromJson(amount, src);
    const converted = original.convert(rate, dst);
    return {
      ok: true as const,
      original: original.format(), from: src.code,
      converted: converted.format(), to: dst.code,
      rate,
      note: `Record the converted figure as the leg amount, and pass fx_currency="${src.code}" ` +
            `and fx_amount="${original.format()}" so the original survives. Rounded half-up once, ` +
            'at the end — no floating point was involved.',
    };
  }

  /**
   * Split an amount by ratios without losing a minor unit.
   *
   * Exposed as a tool because division is exactly the arithmetic a language
   * model gets wrong, and it gets it wrong quietly: three "thirds" of 100 that
   * sum to 99.99 look right until they reach a ledger that refuses to balance.
   */
  allocate(amount: string, ratios: number[]) {
    const m = Money.fromJson(amount, this.currency);
    const parts = m.allocate(ratios);
    return {
      ok: true as const,
      amount: m.format(), ratios,
      parts: parts.map((p) => p.format()),
      sum: parts.reduce((s, p) => s.add(p), Money.zero(this.currency)).format(),
      currency: this.currency.code,
      note: 'The parts sum exactly to the original amount. Use these figures verbatim; do not round them.',
    };
  }


  /**
   * Balance of an account at the END of a business date.
   *
   * Deliberately by date, not by chain position. Anchoring to seq looks more
   * rigorous — seq is total and monotonic, a date is not — but in an
   * append-only ledger it makes the assertion vacuous: a new entry always gets
   * a higher seq, so "the balance as of seq 47" can never change, and the
   * check can only ever re-confirm what the hash chain already proved.
   *
   * The whole point of an assertion is to catch the entry that was missed and
   * posted later. Backdating a July entry changes what July closed at, and
   * that divergence is exactly what is worth failing on.
   *
   * "End of that date" — every entry dated on or before it counts, same
   * convention as hledger. Several entries sharing a date is fine: they are
   * all either in or out together.
   */
  private balanceUpTo(account: string, date: string, subtree: boolean): bigint {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN a.type IN ('asset','expense')
             THEN CASE WHEN p.side = 'debit'  THEN p.amount ELSE -p.amount END
             ELSE CASE WHEN p.side = 'credit' THEN p.amount ELSE -p.amount END
        END), 0) AS bal
      FROM postings p
      JOIN entries  e ON e.id = p.entry_id
      JOIN accounts a ON a.id = p.account_id
      WHERE e.date <= ?
        AND (p.account_id = ? OR (? = 1 AND p.account_id LIKE ?))
    `).get(date, account, subtree ? 1 : 0, account + ':%') as any;
    return BigInt(row.bal);
  }

  /**
   * Record that an account held exactly this much, right now.
   *
   * This is the one check that looks outward. The hash chain proves nobody
   * altered what is written down; it cannot tell you something was never
   * written down at all. An entry that was simply missed leaves a book that is
   * internally flawless — chain intact, trial balance level, accounting
   * identity satisfied — and wrong. Comparing against a bank statement is the
   * only way that surfaces, and an assertion is how that comparison is kept.
   *
   * A mismatch is refused rather than recorded. An assertion that is known to
   * disagree with the books is not a checkpoint, it is a note saying the books
   * are wrong — and it belongs in a correcting entry, not here.
   */
  assertBalance(account: string, amount: string, opts: {
    subtree?: boolean; note?: string; actor?: string; date?: string;
  } = {}) {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account)) {
      throw err('UNKNOWN_ACCOUNT', `account ${JSON.stringify(account)} does not exist`,
        'Use postledger_chart to see the available accounts.',
        { did_you_mean: this.suggestAccounts(account) });
    }
    const claimed = Money.fromJson(amount, this.currency);
    const date = opts.date ?? nowIso().slice(0, 10);
    if (!ISO_DATE.test(date)) {
      throw err('BAD_DATE', `date ${JSON.stringify(date)} is not YYYY-MM-DD`, 'Use an ISO date like "2026-08-08".');
    }
    const head = this.db.prepare('SELECT MAX(seq) m FROM entries').get() as any;
    const atSeq = Number(head?.m ?? 0);
    const subtree = opts.subtree ?? false;
    const actual = Money.ofMinor(this.balanceUpTo(account, date, subtree), this.currency);

    if (!actual.equals(claimed)) {
      const diff = claimed.subtract(actual);
      throw err('ASSERTION_FAILED',
        `${account}${subtree ? ' (with sub-accounts)' : ''} holds ${actual.format()} as of ${date}, not ${claimed.format()}`,
        `The books and the figure you gave differ by ${diff.abs().format()}. ` +
        `If the figure is right, something is missing from the books — find and post it, then assert again. ` +
        `If the books are right, re-read the source. Do not record an assertion you know to be false.`,
        { account, in_books: actual.format(), asserted: claimed.format(),
          difference: diff.format(), as_of: date, at_entry_seq: atSeq });
    }

    this.db.prepare(
      `INSERT INTO assertions (account,amount,at_entry_seq,date,subtree,claimed_actor,note,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(account, actual.minor, BigInt(atSeq), date, subtree ? 1 : 0,
          opts.actor ?? null, opts.note ?? null, nowIso());

    return {
      ok: true as const, account, amount: actual.format(), at_entry_seq: atSeq,
      date, subtree, currency: this.currency.code,
      note: 'Recorded. `postledger verify` re-checks every assertion against the journal from now on.',
    };
  }

  /**
   * Write an assertion for every account that currently holds a balance.
   *
   * The recommended way to start asserting: reconcile once by hand, then take
   * a snapshot of everything at that moment. From then on the divergence has
   * somewhere to be caught.
   */
  generateAssertions(opts: { types?: string[]; actor?: string; note?: string } = {}) {
    const types = opts.types ?? ['asset', 'liability'];
    const rows = this.db.prepare(
      `SELECT account_id, balance FROM v_balances WHERE balance <> 0
         AND account_id IN (SELECT id FROM accounts WHERE type IN (${types.map(() => '?').join(',')})
                                                      AND closed_at IS NULL)
       ORDER BY account_id`).all(...types) as any[];

    const written = rows.map((r) => this.assertBalance(
      r.account_id, Money.ofMinor(BigInt(r.balance), this.currency).format(),
      { actor: opts.actor, note: opts.note ?? 'generated snapshot' }));

    return {
      ok: true as const, generated: written.length,
      assertions: written.map((w) => ({ account: w.account, amount: w.amount })),
      note: written.length
        ? 'Snapshot recorded. These only mean something if the balances were reconciled against reality first.'
        : 'No accounts of those types hold a non-zero balance; nothing to assert.',
    };
  }

  /** Every assertion ever recorded, newest first. */
  assertions(opts: { account?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where = opts.account ? 'WHERE account = ?' : '';
    const args: any[] = opts.account ? [opts.account] : [];
    const rows = this.db.prepare(
      `SELECT * FROM assertions ${where} ORDER BY seq DESC LIMIT ?`).all(...args, limit) as any[];
    return {
      ok: true as const, count: rows.length,
      assertions: rows.map((r) => ({
        seq: Number(r.seq), account: r.account,
        amount: Money.ofMinor(BigInt(r.amount), this.currency).format(),
        at_entry_seq: Number(r.at_entry_seq), date: r.date,
        subtree: Number(r.subtree) === 1, actor: r.claimed_actor, note: r.note,
      })),
    };
  }

  /**
   * Accounts that have been asserted before but not lately.
   *
   * Borrowed from hledger's `check recentassertions`: it turns "we should
   * reconcile" from a discipline into something a machine can fail on. An
   * account you once checked and then stopped checking is more dangerous than
   * one you never checked, because the earlier assertion makes it look tended.
   */
  staleAssertions(opts: { withinDays?: number } = {}) {
    const days = opts.withinDays ?? 30;
    const rows = this.db.prepare(`
      SELECT a.account,
             MAX(a.at_entry_seq) AS last_asserted_seq,
             (SELECT MAX(e.seq) FROM postings p JOIN entries e ON e.id = p.entry_id
               WHERE p.account_id = a.account) AS last_activity_seq,
             (SELECT MAX(e.date) FROM postings p JOIN entries e ON e.id = p.entry_id
               WHERE p.account_id = a.account) AS last_activity_date,
             MAX(a.date) AS last_asserted_date
      FROM assertions a GROUP BY a.account`).all() as any[];

    const stale = rows.filter((r) => {
      if (Number(r.last_activity_seq ?? 0) <= Number(r.last_asserted_seq)) return false;
      const gap = (Date.parse(r.last_activity_date + 'T00:00:00Z') -
                   Date.parse(r.last_asserted_date + 'T00:00:00Z')) / 86_400_000;
      return gap > days;
    });

    return {
      ok: stale.length === 0, checked: rows.length, within_days: days,
      stale: stale.map((r) => ({
        account: r.account, last_asserted: r.last_asserted_date,
        entries_since: Number(r.last_activity_seq) - Number(r.last_asserted_seq),
        last_activity: r.last_activity_date,
      })),
      note: rows.length === 0
        ? 'No assertions have ever been recorded, so there is nothing to go stale. Consider `postledger assert --generate`.'
        : stale.length === 0
          ? 'Every asserted account has been re-checked recently enough.'
          : 'These accounts were checked once and have moved a lot since. An account that looks tended but is not is worse than one nobody claimed to be watching.',
    };
  }


  /** The chain head, for external anchoring. An anchor only means something once it has left this machine. */
  anchor() {
    const head = this.db.prepare('SELECT hash, seq FROM entries ORDER BY seq DESC LIMIT 1').get() as any;
    const at = nowIso();
    return {
      ok: true as const,
      book: this.bookName,
      seq: head ? Number(head.seq) : 0,
      hash: head?.hash ?? null,
      at,
      /** A line ready to `>>` straight onto the anchor log (seq TAB hash TAB time) */
      line: head ? `${Number(head.seq)}\t${head.hash}\t${at}` : '',
      note: 'Anchor this outside the machine (git commit, email, another host). ' +
            'A hash that never leaves the box proves nothing against whoever owns the box.',
    };
  }

  /**
   * Statistical forensics — surfacing what's "worth a look", not passing judgment.
   * See the note at the top of src/audit.ts about indicator ≠ evidence.
   */
  auditSignals(opts: { thresholds?: number[]; account?: string } = {}) {
    const where = opts.account
      ? 'WHERE EXISTS (SELECT 1 FROM postings q WHERE q.entry_id = e.id AND q.account_id = ?)' : '';
    const args = opts.account ? [opts.account] : [];

    const rows = this.db.prepare(
      `SELECT e.id, e.date, e.description, e.declared_total, e.created_at, e.claimed_actor
       FROM entries e ${where} ORDER BY e.seq`).all(...args) as any[];

    const entries = rows.map((r) => ({
      id: r.id, date: r.date, description: r.description,
      total: BigInt(r.declared_total), createdAt: r.created_at, actor: r.claimed_actor,
    }));

    // Use per-leg amounts rather than entry totals for Benford — a bigger sample, and closer to the "raw transaction amount"
    const legAmounts = (this.db.prepare(
      `SELECT p.amount FROM postings p JOIN entries e ON e.id = p.entry_id ${where}`,
    ).all(...args) as any[]).map((r) => BigInt(r.amount));

    const signals = [
      roundNumbers(legAmounts, this.currency.decimals),
      duplicateAmounts(entries),
      thresholdClustering(legAmounts, this.currency.decimals, opts.thresholds ?? [1000, 5000, 10000, 50000]),
      outliers(entries),
      timingPattern(entries.map((e) => ({ id: e.id, createdAt: e.createdAt, actor: e.actor }))),
    ];

    return {
      ok: true as const,
      sample: { entries: entries.length, postings: legAmounts.length },
      benford: benford(legAmounts),
      signals,
      worth_a_look: signals.filter((s) => s.severity === 'look').map((s) => s.signal),
      disclaimer:
        'Every item here is an INDICATOR, not evidence. Deviation is not fraud and conformity is not ' +
        'innocence. Use these to decide which entries to open the source documents for — nothing more.',
    };
  }

  // -- Documents ----------------------------------------------------------------

  /** Archive an original document and bind it to an entry. Content-addressed, never overwritten. */
  attach(entryId: string, filePath: string, kind: string, opts: { idempotencyKey: string }) {
    const entry = this.db.prepare('SELECT id FROM entries WHERE id = ?').get(entryId);
    if (!entry) throw err('ENTRY_NOT_FOUND', `no entry ${entryId}`, 'Post the entry first, then attach its document.');
    if (!existsSync(filePath)) {
      throw err('FILE_NOT_FOUND', `no file at ${filePath}`, 'Give an absolute path to a file on this machine.');
    }

    const requestHash = sha256(canonical({ op: 'attach', entryId, filePath, kind }));
    const replay = this.claim(opts.idempotencyKey, 'attach', requestHash);
    if (replay) return { ...replay.response, replayed: true };

    try {
      const bytes = readFileSync(filePath);
      const sha = sha256(bytes);
      const ext = filePath.includes('.') ? '.' + filePath.split('.').pop() : '';
      const rel = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}${ext}`;
      const abs = join(this.docsDir, rel);

      let deduplicated = false;
      if (existsSync(abs)) {
        deduplicated = true;                    // this exact file is already in the store — never overwrite
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        const tmp = abs + '.tmp';
        writeFileSync(tmp, bytes);
        renameSync(tmp, abs);                   // atomic landing
        chmodSync(abs, 0o440);                  // read-only
      }

      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(
          'INSERT OR IGNORE INTO documents (sha256,bytes,mime,orig_name,rel_path,stored_at) VALUES (?,?,?,?,?,?)',
        ).run(sha, BigInt(bytes.length), null, filePath.split('/').pop() ?? null, rel, nowIso());
        this.db.prepare(
          'INSERT OR IGNORE INTO entry_documents (entry_id,sha256,kind,linked_at) VALUES (?,?,?,?)',
        ).run(entryId, sha, kind, nowIso());
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }

      const result = { ok: true as const, entry_id: entryId, sha256: sha, bytes: bytes.length, kind, rel_path: rel, deduplicated };
      this.settle(opts.idempotencyKey, result);
      return { ...result, replayed: false };
    } catch (e: any) {
      this.markFailed(opts.idempotencyKey, e.message);
      throw e;
    }
  }

  documentsOf(entryId: string) {
    const rows = this.db.prepare(`SELECT d.*, ed.kind, ed.linked_at FROM entry_documents ed
      JOIN documents d ON d.sha256 = ed.sha256 WHERE ed.entry_id = ?`).all(entryId) as any[];
    return { ok: true as const, entry_id: entryId, count: rows.length,
      documents: rows.map((r) => ({ sha256: r.sha256, kind: r.kind, bytes: Number(r.bytes), orig_name: r.orig_name, rel_path: r.rel_path })) };
  }

  /** Look up entries from a document — the other half of "being able to trace it back later" */
  entriesOfDocument(sha: string) {
    const rows = this.db.prepare(`SELECT e.id, e.date, e.description, ed.kind FROM entry_documents ed
      JOIN entries e ON e.id = ed.entry_id WHERE ed.sha256 = ?`).all(sha) as any[];
    return { ok: true as const, sha256: sha, count: rows.length, entries: rows };
  }

  /**
   * Read a bank statement into candidate transactions. Nothing is posted.
   *
   * A statement line says money moved; it does not say which account faces it.
   * That call belongs to whoever is reading it — and in this system that is
   * usually a model, which does it better than a rules table. So the ledger
   * parses and fingerprints, and hands the judgement back.
   */
  readStatement(csv: string, profile: CsvProfile) {
    const r = readStatement(csv, profile, this.currency, sha256);
    // Flag candidates whose fingerprint was already used, so the caller can
    // see at a glance what is new rather than posting everything and relying
    // on replays to sort it out.
    const known = this.db.prepare(
      "SELECT 1 FROM idempotency WHERE key = ? UNION SELECT 1 FROM entries WHERE idempotency_key = ?");
    return {
      ...r,
      candidates: r.candidates.map((c) => ({
        ...c,
        suggested_key: `stmt:${c.fingerprint}`,
        already_posted: !!known.get(`stmt:${c.fingerprint}`, `stmt:${c.fingerprint}`),
      })),
    };
  }


  /**
   * Close a period: nothing dated on or before `asOf` can be posted any more.
   *
   * A close is an event, not a setting. It carries a name you can refer to,
   * it can be listed, and reopening it is recorded rather than being a silent
   * rewind of a number. In a ledger where every correction is visible, closing
   * the books should not be the one operation that leaves no trace.
   */
  closePeriod(name: string, asOf: string, opts: { actor?: string; note?: string } = {}) {
    if (!ISO_DATE.test(asOf)) {
      throw err('BAD_DATE', `as_of ${JSON.stringify(asOf)} is not YYYY-MM-DD`, 'Use an ISO date like "2026-03-31".');
    }
    if (!name?.trim()) {
      throw err('MISSING_NAME', 'a period close needs a name',
        'Name it the way you would refer to it out loud: "FY2026 Q1", "March 2026".');
    }
    const open = this.db.prepare(
      'SELECT name, as_of FROM period_closes WHERE reopened_at IS NULL AND as_of >= ? ORDER BY as_of DESC LIMIT 1',
    ).get(asOf) as any;
    if (open) {
      throw err('ALREADY_CLOSED',
        `${asOf} is already covered by "${open.name}" (closed through ${open.as_of})`,
        'Closes only move forward. To change an earlier one, reopen it first — which is recorded.');
    }
    const conflicting = this.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE date <= ?').get(asOf) as any;
    this.db.prepare(
      'INSERT INTO period_closes (name,as_of,closed_at,closed_by,note) VALUES (?,?,?,?,?)',
    ).run(name.trim(), asOf, nowIso(), opts.actor ?? null, opts.note ?? null);
    return {
      ok: true as const, name: name.trim(), as_of: asOf,
      entries_covered: Number(conflicting.c),
      note: 'Nothing dated on or before this can be posted now. Reopening is possible and will be recorded.',
    };
  }

  /** Reopen a closed period. Recorded, and only possible once per close. */
  reopenPeriod(seq: number, reason: string, opts: { actor?: string } = {}) {
    const row = this.db.prepare('SELECT * FROM period_closes WHERE seq = ?').get(BigInt(seq)) as any;
    if (!row) throw err('PERIOD_NOT_FOUND', `no period close #${seq}`, 'List them with `postledger periods`.');
    if (row.reopened_at) {
      throw err('ALREADY_REOPENED', `period close #${seq} ("${row.name}") was already reopened on ${row.reopened_at}`,
        'A close can be reopened once. Close the period again if you need it locked, then reopen that.');
    }
    if (!reason?.trim()) {
      throw err('MISSING_REASON', 'reopening a period requires a reason',
        'This goes into the permanent record. Say what needs to change and why it could not wait.');
    }
    this.db.prepare(
      'UPDATE period_closes SET reopened_at=?, reopened_by=?, reopen_reason=? WHERE seq=?',
    ).run(nowIso(), opts.actor ?? null, reason.trim(), BigInt(seq));
    return { ok: true as const, seq, name: row.name, as_of: row.as_of, reason: reason.trim(),
             note: 'The period is open again, and this reopening is now part of the record.' };
  }

  /** Every close ever made, including reopened ones. */
  periods() {
    const rows = this.db.prepare('SELECT * FROM period_closes ORDER BY as_of DESC').all() as any[];
    const openThrough = this.db.prepare(
      'SELECT MAX(as_of) m FROM period_closes WHERE reopened_at IS NULL').get() as any;
    return {
      ok: true as const,
      closed_through: openThrough?.m ?? null,
      count: rows.length,
      periods: rows.map((r) => ({
        seq: Number(r.seq), name: r.name, as_of: r.as_of,
        closed_at: r.closed_at, closed_by: r.closed_by, note: r.note,
        reopened: !!r.reopened_at,
        ...(r.reopened_at ? { reopened_at: r.reopened_at, reopened_by: r.reopened_by,
                              reopen_reason: r.reopen_reason } : {}),
      })),
    };
  }

  /**
   * Kept for compatibility: the old scalar lock, expressed as a close.
   * Prefer closePeriod, which lets you name it and reopen it deliberately.
   */
  lock(date: string) {
    const r = this.closePeriod(`locked through ${date}`, date, { note: 'created via the legacy lock command' });
    return { ok: true as const, lock_date: date, closed_as: r.name };
  }


  info() {
    const meta = this.readMeta();
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM entries) e, (SELECT COUNT(*) FROM accounts) a,
      (SELECT COUNT(*) FROM documents) d`).get() as any;
    const head = this.db.prepare('SELECT hash, seq FROM entries ORDER BY seq DESC LIMIT 1').get() as any;
    return {
      ok: true as const, path: this.path, book: this.bookName, currency: this.currency.code,
      lock_date: meta.lock_date ?? null,
      entries: Number(counts.e), accounts: Number(counts.a), documents: Number(counts.d),
      chain_head: head?.hash ?? null, chain_length: head ? Number(head.seq) : 0,
    };
  }
}
