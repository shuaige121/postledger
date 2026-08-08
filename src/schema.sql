-- postledger — ledger schema
--
-- Design axiom: callers are not trusted. LLMs replay requests, drop lines,
-- miscalculate totals, and invent accounts. So every accounting invariant
-- must hold at the **database layer**; application-layer checks exist only
-- to produce a friendlier error message.
--
-- Every trigger in this file has a matching test (tests/invariants.test.ts).
-- Delete any trigger and a test should go red — that's deliberate.
--
-- ⚠ Lesson learned the hard way: a trigger being documented in the
--   architecture doc doesn't mean it's in the schema. During development,
--   a missing posting_no_update let an "edit the amount" attack punch
--   straight through every other safeguard, with nothing in the ledger
--   itself looking wrong. Hence: the trigger list IS the test list, one to one.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys  = ON;      -- connection-scoped; must be reset on every connect
PRAGMA synchronous   = FULL;    -- financial data — slower is fine, losing writes isn't

-- ---------------------------------------------------------------------------
-- meta: ledger-level properties. One file = one book.
--
-- Why one book per file: backup is cp, archiving is tar, permissions are
-- chmod, syncing is rsync. And given the "no trusted identity" premise,
-- filesystem permissions are the only ACL a local tool can actually rely on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Required: book_name / currency / currency_decimals / schema_version / created_at
-- Optional: lock_date (no new entries accepted on or before this date, to stop an agent from time-traveling)

-- meta rows may be updated (lock_date advances, head gets refreshed), but head itself lives in the append-only chain_head table

-- ---------------------------------------------------------------------------
-- accounts: the chart of accounts
--
-- Hierarchy is expressed with beancount-style colon naming
-- (Expenses:Meals:Team) — **no tree table**. Reports aggregate by prefix.
-- This one decision cuts out all the complexity of parent_id, closure
-- tables, and moving subtrees around.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,          -- 'Assets:Bank:Checking'
  type          TEXT NOT NULL CHECK (type IN
                  ('asset','liability','equity','income','expense')),
  -- Overdraft is a per-account policy, not a global switch:
  -- a cash drawer should never go negative; a customer deposit (a liability) can.
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0,1)),
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,                      -- no postings allowed once closed, but history stays
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts (type);

-- Account names must be a valid colon path: non-empty segments, no leading/trailing colon, no empty segments
CREATE TRIGGER IF NOT EXISTS account_name_shape
BEFORE INSERT ON accounts
BEGIN
  SELECT RAISE(ABORT, 'postledger: account name must be Colon:Separated:Path')
  WHERE NEW.id NOT GLOB '[A-Za-z]*'
     OR NEW.id GLOB '*::*'
     OR NEW.id GLOB '*:'
     OR NEW.id GLOB '* *';
END;

-- ---------------------------------------------------------------------------
-- postings: entry legs
--
-- Amount is always positive (CHECK amount > 0); direction lives in side.
-- This removes the "is -100 debit the same thing as 100 credit?" ambiguity,
-- and lets the CHECK (amount > 0) constraint actually mean something.
--
-- amount is denominated in the book's currency minor unit: cents for
-- SGD/USD, whole yen for JPY. There is no floating point anywhere in this
-- database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS postings (
  entry_id   TEXT    NOT NULL,
  seq        INTEGER NOT NULL,             -- this leg's position within the entry, starting at 1
  account_id TEXT    NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  side       TEXT    NOT NULL CHECK (side IN ('debit','credit')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  memo       TEXT,
  PRIMARY KEY (entry_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_postings_account ON postings (account_id);

-- ---------------------------------------------------------------------------
-- entries: the entry head — simultaneously the **sealing action** and one
-- link in the audit chain
--
-- Write order is deliberately inverted:
--   1. INSERT all postings   (no head exists yet → the entry is "unsealed",
--      invisible to the read path)
--   2. INSERT the entry head ← the BEFORE INSERT trigger validates the
--      whole entry at this exact moment
--
-- SQLite has no deferred triggers, so inserting legs one at a time
-- necessarily passes through unbalanced intermediate states. "Seal last"
-- compresses validation into a single atomic moment and sidesteps that
-- limitation — and as a bonus, entries never needs UPDATE, so append-only
-- can be an unconditional guarantee.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entries (
  id             TEXT PRIMARY KEY,
  date           TEXT NOT NULL,            -- YYYY-MM-DD, the business date (format enforced at the application layer)
  description    TEXT NOT NULL,

  -- Redundant declared-intent cross-check: the caller must independently
  -- state both of these numbers, the server recomputes them, and a
  -- mismatch is rejected. LLM mistakes are almost always **internally
  -- inconsistent** — a hallucinated extra line rarely comes with a total
  -- that happens to still balance.
  declared_total INTEGER NOT NULL CHECK (declared_total > 0),  -- sum of debits
  declared_legs  INTEGER NOT NULL CHECK (declared_legs >= 2),  -- number of legs

  -- Identity: under stdio MCP there is **no trusted identity at all**. The
  -- field name calls this out honestly — it's a self-reported value from
  -- the caller, not a verified identity. It enters the hash chain, so a
  -- false claim can't be edited after the fact, but nothing stops the
  -- false claim from being made in the first place.
  claimed_actor  TEXT,

  idempotency_key TEXT,
  created_at     TEXT NOT NULL,            -- when the entry was recorded (≠ the business date)

  -- Audit chain. The entry itself is the unit of audit, so there's no
  -- separate audit_log table — the ledger is already append-only, and a
  -- second log would just be two copies of the same fact drifting apart.
  prev_hash      TEXT,                     -- NULL for the first entry
  hash           TEXT NOT NULL,
  seq            INTEGER NOT NULL UNIQUE    -- monotonically increasing chain sequence number
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON entries (date);
CREATE INDEX IF NOT EXISTS idx_entries_seq  ON entries (seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_idem
  ON entries (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- === Sealing validation: this is where accounting invariants become hard database-layer constraints ===
CREATE TRIGGER IF NOT EXISTS entry_seal
BEFORE INSERT ON entries
BEGIN
  -- Leg count must match what was declared — catches "missing / extra rows"
  SELECT RAISE(ABORT, 'postledger: declared_legs mismatch — a line was probably dropped or duplicated')
  WHERE (SELECT COUNT(*) FROM postings WHERE entry_id = NEW.id) <> NEW.declared_legs;

  -- The floor for double-entry: at least two legs
  SELECT RAISE(ABORT, 'postledger: an entry needs at least 2 postings')
  WHERE (SELECT COUNT(*) FROM postings WHERE entry_id = NEW.id) < 2;

  -- Debits equal credits — the first axiom of double-entry accounting
  SELECT RAISE(ABORT, 'postledger: unbalanced entry (debits != credits)')
  WHERE (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE -amount END), 0)
         FROM postings WHERE entry_id = NEW.id) <> 0;

  -- The debit total must match what was declared — catches "arithmetic errors"
  SELECT RAISE(ABORT, 'postledger: declared_total mismatch — the declared total disagrees with the legs')
  WHERE (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE 0 END), 0)
         FROM postings WHERE entry_id = NEW.id) <> NEW.declared_total;

  -- Cannot post into a closed account
  SELECT RAISE(ABORT, 'postledger: entry references a closed account')
  WHERE EXISTS (
    SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
    WHERE p.entry_id = NEW.id AND a.closed_at IS NOT NULL
  );

  -- Lock date: stops an agent from backdating an entry into an already-closed period
  SELECT RAISE(ABORT, 'postledger: date is on or before the lock date')
  WHERE NEW.date <= COALESCE((SELECT value FROM meta WHERE key = 'lock_date'), '');

  -- Chain sequence numbers must be contiguous — prevents forged insertions out of order
  SELECT RAISE(ABORT, 'postledger: seq must be exactly prev + 1')
  WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM entries), 0) + 1;

  -- The chain must link up with the previous entry
  SELECT RAISE(ABORT, 'postledger: prev_hash does not match the current chain head')
  WHERE COALESCE(NEW.prev_hash, '') <>
        COALESCE((SELECT hash FROM entries WHERE seq = NEW.seq - 1), '');
END;

-- === Immutability: covers the ledger data itself, not just the audit table ===
-- (A common failure mode: append-only protects only the audit table while
--   the main table is left exposed with CASCADE children, so a single
--   `DELETE FROM invoices` takes the line items and transactions down with
--   it — and the integrity check still happily returns valid=true.)

CREATE TRIGGER IF NOT EXISTS entry_no_update
BEFORE UPDATE ON entries
BEGIN SELECT RAISE(ABORT, 'postledger: entries are append-only'); END;

CREATE TRIGGER IF NOT EXISTS entry_no_delete
BEFORE DELETE ON entries
BEGIN SELECT RAISE(ABORT, 'postledger: entries are append-only; correct with a reversal'); END;

CREATE TRIGGER IF NOT EXISTS posting_no_update
BEFORE UPDATE ON postings
BEGIN SELECT RAISE(ABORT, 'postledger: postings are immutable'); END;

-- Legs belonging to a sealed entry can't be deleted; unsealed orphan legs
-- can be cleaned up — otherwise a single failed write leaves permanent garbage behind
CREATE TRIGGER IF NOT EXISTS posting_no_delete
BEFORE DELETE ON postings
BEGIN
  SELECT RAISE(ABORT, 'postledger: postings of a sealed entry are immutable')
  WHERE EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id);
END;

-- No appending legs after sealing — otherwise "write two balanced legs → seal → append a third" would sail right past validation
CREATE TRIGGER IF NOT EXISTS posting_no_append_after_seal
BEFORE INSERT ON postings
BEGIN
  SELECT RAISE(ABORT, 'postledger: entry is sealed; corrections must be reversal entries')
  WHERE EXISTS (SELECT 1 FROM entries WHERE id = NEW.entry_id);
END;

-- ---------------------------------------------------------------------------
-- reversals: reversal is the only way to correct an entry, and it's a first-class citizen here
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reversals (
  reversing_entry_id TEXT PRIMARY KEY REFERENCES entries (id) ON DELETE RESTRICT,
  reversed_entry_id  TEXT NOT NULL     REFERENCES entries (id) ON DELETE RESTRICT,
  reason             TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

-- An entry can only be reversed once
CREATE UNIQUE INDEX IF NOT EXISTS idx_reversals_target
  ON reversals (reversed_entry_id);

CREATE TRIGGER IF NOT EXISTS reversal_no_update
BEFORE UPDATE ON reversals
BEGIN SELECT RAISE(ABORT, 'postledger: reversals are append-only'); END;

CREATE TRIGGER IF NOT EXISTS reversal_no_delete
BEFORE DELETE ON reversals
BEGIN SELECT RAISE(ABORT, 'postledger: reversals are append-only'); END;

-- ---------------------------------------------------------------------------
-- idempotency: insert-first, so there's no check-then-act window
--
-- A common implementation flaw: the pre-check SELECT runs outside the
-- transaction and the INSERT runs inside it, so under concurrent requests
-- with the same key, the loser slams into the primary key and throws a raw
-- sqlite3.IntegrityError straight through to the MCP layer. The data stays
-- safe, but the model gets handed a crash instead of "this key is already
-- in progress."
--
-- The approach here: claiming the key IS the atomic operation.
--   INSERT ... succeeds → I hold the right to execute
--   INSERT ... conflicts → read that row back, and respond with one of
--   four outcomes based on its request_hash and status
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency (
  key          TEXT PRIMARY KEY,
  operation    TEXT NOT NULL,
  request_hash TEXT NOT NULL,             -- sha256(canonical({op, args}))
  status       TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  response     TEXT,                       -- JSON; replayed back when status is completed
  error        TEXT,
  claimed_at   TEXT NOT NULL,              -- basis for self-healing an in_progress row that timed out
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_idem_status ON idempotency (status, claimed_at);

-- ---------------------------------------------------------------------------
-- documents: source documents get archived here so they can be matched back later
--
-- Content-addressed: the same file is stored exactly once; its sha256 IS
-- its identity. On-disk flow: write to a temp file → atomic rename into
-- place → chmod 0440 → skip (never overwrite) if it already exists.
--
-- ⚠ Critical: verify MUST **recompute the sha256 of the on-disk file** and
--   compare it against this table. Storing a sha256 and never recomputing
--   it is a common shortcut, which means a swapped-out PDF would go
--   completely undetected. A fingerprint you never check is the same as
--   not having stored one at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  sha256    TEXT PRIMARY KEY,
  bytes     INTEGER NOT NULL CHECK (bytes > 0),
  mime      TEXT,
  orig_name TEXT,
  rel_path  TEXT NOT NULL UNIQUE,          -- ab/cd/abcd....pdf
  stored_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_documents (
  entry_id TEXT NOT NULL REFERENCES entries (id)     ON DELETE RESTRICT,
  sha256   TEXT NOT NULL REFERENCES documents (sha256) ON DELETE RESTRICT,
  kind     TEXT NOT NULL CHECK (kind IN
             ('invoice','receipt','contract','statement','bank_slip','other')),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, sha256, kind)
);

CREATE INDEX IF NOT EXISTS idx_entry_docs_sha ON entry_documents (sha256);

CREATE TRIGGER IF NOT EXISTS document_no_update
BEFORE UPDATE ON documents
BEGIN SELECT RAISE(ABORT, 'postledger: archived documents are immutable'); END;

CREATE TRIGGER IF NOT EXISTS document_no_delete
BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'postledger: archived documents are never deleted'); END;

-- ---------------------------------------------------------------------------
-- chain_head: the chain-head anchor, append-only
--
-- In a lot of implementations, the chain can be truncated from the tail:
-- head_hash exists only as the return value of a verification function,
-- never persisted anywhere and never externally anchored, so deleting the
-- last N rows leaves the remaining chain perfectly self-consistent.
--
-- Here, every write appends a new head snapshot. Truncation leaves the
-- last row of chain_head out of sync with the actual chain tail in
-- entries, which is exactly what verify catches.
--
-- Being honest about the limit: this only defends against tampering that
-- doesn't recompute the whole chain. Anyone with local write access can
-- still recompute the entire chain from scratch. The real defense is
-- getting the head off this machine — see `postledger anchor`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_head (
  seq        INTEGER PRIMARY KEY,          -- corresponds to entries.seq
  hash       TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS chain_head_no_update
BEFORE UPDATE ON chain_head
BEGIN SELECT RAISE(ABORT, 'postledger: chain head history is append-only'); END;

CREATE TRIGGER IF NOT EXISTS chain_head_no_delete
BEFORE DELETE ON chain_head
BEGIN SELECT RAISE(ABORT, 'postledger: chain head history is append-only'); END;

-- ---------------------------------------------------------------------------
-- Views: derived data. All of it can be recomputed from postings; verify
-- asserts that the two agree.
-- ---------------------------------------------------------------------------

-- Only sealed entries are visible to the read path
CREATE VIEW IF NOT EXISTS v_postings AS
SELECT p.*, e.date, e.seq AS entry_seq, e.description
FROM postings p
JOIN entries e ON e.id = p.entry_id;

-- Account balances: signed "normal balance"
-- asset/expense are positive on the debit side; liability/equity/income are positive on the credit side
CREATE VIEW IF NOT EXISTS v_balances AS
SELECT a.id                AS account_id,
       a.type,
       COALESCE(SUM(
         CASE WHEN a.type IN ('asset','expense')
              THEN CASE WHEN p.side = 'debit'  THEN p.amount ELSE -p.amount END
              ELSE CASE WHEN p.side = 'credit' THEN p.amount ELSE -p.amount END
         END), 0)          AS balance
FROM accounts a
LEFT JOIN v_postings p ON p.account_id = a.id
GROUP BY a.id, a.type;

-- Trial balance: total debits must equal total credits, or the ledger is already broken
CREATE VIEW IF NOT EXISTS v_trial_balance AS
SELECT COALESCE(SUM(CASE WHEN side = 'debit'  THEN amount ELSE 0 END), 0) AS total_debits,
       COALESCE(SUM(CASE WHEN side = 'credit' THEN amount ELSE 0 END), 0) AS total_credits
FROM v_postings;

-- Unsealed orphan legs: should always be empty in the normal case. Non-empty means a write crashed midway.
CREATE VIEW IF NOT EXISTS v_orphan_postings AS
SELECT p.* FROM postings p
WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = p.entry_id);
