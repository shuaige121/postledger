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

export const CURRENT_SCHEMA_VERSION = 2;

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
