/**
 * Schema migrations.
 *
 * A book is a file that outlives the code that made it. Someone will open a
 * book created by 0.1.0 with a much later version, and that has to work
 * without them doing anything — there is no server to run a migration on and
 * no ops team to run it.
 *
 * Rules this file follows, all of which exist because the alternative breaks
 * an append-only ledger:
 *
 *   1. **Additive only.** New tables, new nullable columns, new indexes and
 *      triggers. Never drop, never rewrite a row, never change a column type.
 *      Rewriting history is the one thing this project exists to prevent, and
 *      a migration is not exempt.
 *   2. **Each step is idempotent** (`IF NOT EXISTS` throughout), so a crash
 *      halfway through is recoverable by running it again.
 *   3. **The version bump is in the same transaction as the change**, so a
 *      book is never left claiming a version it does not have.
 *   4. **Forward only.** There are no down-migrations: undoing an additive
 *      change means dropping data, and we do not drop data. To go back, use
 *      an older copy of the file.
 */

import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 4;

interface Migration {
  version: number;
  description: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: 'balance assertions',
    sql: `
-- Persistent balance assertions: "this account held exactly this much at this
-- point in the chain".
--
-- The hash chain proves the ledger has not been altered. It says nothing about
-- whether the ledger matches reality — a whole entry that was never recorded
-- leaves a book that is internally perfect and externally wrong. Chain check
-- passes, trial balance passes, the accounting identity passes. Assertions are
-- the only mechanism here that can catch it.
--
-- Anchored to entry seq rather than to a date. Dates are ambiguous when several
-- entries share one (which comes first?); seq is total and monotonic, so
-- "the balance as of seq N" has exactly one answer, forever.
CREATE TABLE IF NOT EXISTS assertions (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  account      TEXT    NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  -- Signed normal balance in minor units. Negative is legal: a credit card
  -- liability, an overdrawn account that opted in.
  amount       INTEGER NOT NULL,
  -- The chain position this assertion describes. 0 means "before any entry".
  at_entry_seq INTEGER NOT NULL CHECK (at_entry_seq >= 0),
  -- Business date, for humans and reports. Never used for verification.
  date         TEXT    NOT NULL,
  -- 1 = the figure covers this account and everything beneath it in the
  -- colon hierarchy (Assets covers Assets:Bank:Checking).
  subtree      INTEGER NOT NULL DEFAULT 0 CHECK (subtree IN (0,1)),
  claimed_actor TEXT,
  note         TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assertions_account ON assertions (account, at_entry_seq);

-- Assertions are evidence of what was checked and when. Editing one would let
-- somebody quietly move a checkpoint to wherever the books happen to be now,
-- which defeats the point.
CREATE TRIGGER IF NOT EXISTS assertion_no_update
BEFORE UPDATE ON assertions
BEGIN SELECT RAISE(ABORT, 'postledger: assertions are append-only'); END;

CREATE TRIGGER IF NOT EXISTS assertion_no_delete
BEFORE DELETE ON assertions
BEGIN SELECT RAISE(ABORT, 'postledger: assertions are append-only'); END;
`,
  },
  {
    version: 3,
    description: 'tax/fx audit columns on postings, and entry-level tags',
    sql: `
-- Four nullable audit columns on postings.
--
-- Added now, while books are young, because this is a one-way door. Postings
-- are immutable, so a column added later can never be filled in for anything
-- already recorded — the history would be permanently blank. And the facts
-- these hold cannot be reconstructed after the fact: one expense account can
-- carry legs at four different VAT rates, so the rate has to be pinned to the
-- leg at the moment it is written or it is gone.
--
-- They are audit columns, not a tax engine. Nothing computes with them; they
-- record what was true when the entry was made, which is the part that cannot
-- be recovered later. A tax engine can be built on top whenever it is needed.
--
-- Snapshot, never reference: the rate goes in as a number, not as a pointer to
-- a rate table. A voucher's tax rate is a historical fact and must not drift
-- when someone edits master data next year.
ALTER TABLE postings ADD COLUMN tax_code   TEXT;
ALTER TABLE postings ADD COLUMN tax_amount INTEGER;
ALTER TABLE postings ADD COLUMN fx_currency TEXT;
ALTER TABLE postings ADD COLUMN fx_amount   INTEGER;

-- Entry-level tags: the second axis, orthogonal to the chart of accounts.
--
-- Without it the only way to say "this belongs to project X" is to fork the
-- account tree — Expenses:Meals:ProjectA, Expenses:Meals:ProjectB — and the
-- chart explodes. Every mature system in this space has a second axis for
-- exactly this reason.
--
-- Stored on the entry and covered by its hash, which means tags cannot be
-- applied after the fact. That is a real limitation and it is deliberate: a
-- tag that can be added later is a tag that can be changed later, and this
-- ledger does not have a "change" operation.
ALTER TABLE entries ADD COLUMN tags TEXT;

CREATE INDEX IF NOT EXISTS idx_postings_tax ON postings (tax_code) WHERE tax_code IS NOT NULL;
`,
  },
  {
    version: 4,
    description: 'named, reopenable period closes',
    sql: `
-- Period closes, replacing a single lock_date scalar in meta.
--
-- A scalar can only move forward and remembers nothing. A close is an event:
-- it has a name you can refer to in conversation ("FY2026 Q1"), it can be
-- listed, and reopening it leaves a record of who reopened it and why instead
-- of silently rewinding a number. In a ledger where every other correction is
-- visible, closing the books should not be the one operation with no history.
CREATE TABLE IF NOT EXISTS period_closes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  -- Everything dated on or before this is closed.
  as_of       TEXT    NOT NULL,
  closed_at   TEXT    NOT NULL,
  closed_by   TEXT,
  note        TEXT,
  -- NULL means still closed. Set means it was deliberately reopened.
  reopened_at   TEXT,
  reopened_by   TEXT,
  reopen_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_period_open ON period_closes (as_of) WHERE reopened_at IS NULL;

-- Rows may be updated ONLY to reopen, and only once. Everything else about a
-- close is a historical fact.
CREATE TRIGGER IF NOT EXISTS period_close_only_reopen
BEFORE UPDATE ON period_closes
BEGIN
  SELECT RAISE(ABORT, 'postledger: a period close is immutable except for reopening it once')
  WHERE OLD.name <> NEW.name OR OLD.as_of <> NEW.as_of
     OR OLD.closed_at <> NEW.closed_at
     OR OLD.reopened_at IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS period_close_no_delete
BEFORE DELETE ON period_closes
BEGIN SELECT RAISE(ABORT, 'postledger: period closes are append-only; reopen instead of deleting'); END;

-- Carry over an existing lock_date so nothing silently unlocks on upgrade.
INSERT INTO period_closes (name, as_of, closed_at, note)
SELECT 'imported lock date', value, datetime('now'), 'migrated from meta.lock_date'
FROM meta WHERE key = 'lock_date';

-- The seal trigger has to consult the new table. SQLite cannot alter a
-- trigger, so it is dropped and recreated with the period check swapped in.
-- Every other clause is reproduced byte for byte; changing one here without
-- changing schema.sql would leave new books and upgraded books enforcing
-- different rules.
DROP TRIGGER IF EXISTS entry_seal;
CREATE TRIGGER entry_seal
BEFORE INSERT ON entries
BEGIN
  SELECT RAISE(ABORT, 'postledger: declared_legs mismatch — a line was probably dropped or duplicated')
  WHERE (SELECT COUNT(*) FROM postings WHERE entry_id = NEW.id) <> NEW.declared_legs;

  SELECT RAISE(ABORT, 'postledger: an entry needs at least 2 postings')
  WHERE (SELECT COUNT(*) FROM postings WHERE entry_id = NEW.id) < 2;

  SELECT RAISE(ABORT, 'postledger: unbalanced entry (debits != credits)')
  WHERE (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE -amount END), 0)
         FROM postings WHERE entry_id = NEW.id) <> 0;

  SELECT RAISE(ABORT, 'postledger: declared_total mismatch — the declared total disagrees with the legs')
  WHERE (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE 0 END), 0)
         FROM postings WHERE entry_id = NEW.id) <> NEW.declared_total;

  SELECT RAISE(ABORT, 'postledger: entry references a closed account')
  WHERE EXISTS (
    SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
    WHERE p.entry_id = NEW.id AND a.closed_at IS NOT NULL
  );

  SELECT RAISE(ABORT, 'postledger: entry would drive an account below zero, and that account does not allow a negative balance')
  WHERE EXISTS (
    SELECT 1
    FROM (SELECT DISTINCT account_id FROM postings WHERE entry_id = NEW.id) t
    JOIN accounts a ON a.id = t.account_id
    WHERE a.allow_negative = 0
      AND (
        SELECT COALESCE(SUM(
          CASE WHEN a.type IN ('asset','expense')
               THEN CASE WHEN p.side = 'debit'  THEN p.amount ELSE -p.amount END
               ELSE CASE WHEN p.side = 'credit' THEN p.amount ELSE -p.amount END
          END), 0)
        FROM postings p
        WHERE p.account_id = t.account_id
          AND (p.entry_id = NEW.id
               OR EXISTS (SELECT 1 FROM entries e WHERE e.id = p.entry_id))
      ) < 0
  );

  SELECT RAISE(ABORT, 'postledger: date falls in a closed period')
  WHERE EXISTS (SELECT 1 FROM period_closes
                 WHERE reopened_at IS NULL AND NEW.date <= as_of);

  SELECT RAISE(ABORT, 'postledger: seq must be exactly prev + 1')
  WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM entries), 0) + 1;

  SELECT RAISE(ABORT, 'postledger: prev_hash does not match the current chain head')
  WHERE COALESCE(NEW.prev_hash, '') <>
        COALESCE((SELECT hash FROM entries WHERE seq = NEW.seq - 1), '');
END;
`,
  },
];

/**
 * Bring a book up to the current schema version.
 *
 * Returns which migrations ran, so callers can say so out loud rather than
 * silently changing a file the user did not ask to change.
 */
export function migrate(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string } | undefined;
  const from = Number(row?.value ?? 1);
  const applied: string[] = [];

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO meta (key,value) VALUES ('schema_version',?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(m.version));
      db.exec('COMMIT');
      applied.push(`v${m.version}: ${m.description}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return { from, to: CURRENT_SCHEMA_VERSION, applied };
}
