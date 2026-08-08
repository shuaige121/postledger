// postledger invariant tests
//
// This file maps 1:1 to the triggers in src/schema.sql.
// Drop any one trigger, and some test here must turn red.
//
// Run: node tests/invariants.mjs
// Exit code: 0 all passed / 1 some failed

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'src', 'schema.sql'), 'utf8');

let pass = 0, fail = 0;
const ok   = (n, extra = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${extra ? '  ' + extra : ''}`); };
const bad  = (n, why)        => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${why}`); };

/** Assert that the database rejects this operation */
const rejects = (name, fn) => {
  try { fn(); bad(name, 'should have been rejected but succeeded'); }
  catch (e) { ok(name, 'rejected: ' + e.message.replace(/^.*postledger: /, '')); }
};
/** Assert that this operation succeeds */
const accepts = (name, fn) => {
  try { fn(); ok(name); }
  catch (e) { bad(name, e.message); }
};
const eq = (name, actual, expected) => {
  if (actual === expected) ok(name, `= ${actual}`);
  else bad(name, `expected ${expected}, got ${actual}`);
};

const canonical = (o) => JSON.stringify(o, Object.keys(o).sort());
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO meta (key,value) VALUES
    ('book_name','test'),('currency','SGD'),('currency_decimals','2'),
    ('schema_version','1'),('created_at','2026-08-08T00:00:00Z')`);
  db.exec(`INSERT INTO accounts (id,type,opened_at) VALUES
    ('Assets:Bank:Checking','asset','2026-01-01'),
    ('Assets:Cash','asset','2026-01-01'),
    ('Income:Sales','income','2026-01-01'),
    ('Expenses:Rent','expense','2026-01-01')`);
  return db;
}

/**
 * Post an entry following postledger's write protocol: write the legs first, then seal.
 * Sealing is where the DB layer validates the whole entry — this is the workaround for
 * SQLite not having deferred triggers.
 */
function post(db, { id, date, desc, legs, declaredTotal, declaredLegs, actor = null, key = null }) {
  const prev = db.prepare('SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1').get();
  const seq = prev ? Number(prev.seq) + 1 : 1;
  const prevHash = prev ? prev.hash : null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const insLeg = db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)');
    legs.forEach((l, i) => insLeg.run(id, i + 1, l.account, l.side, BigInt(l.amount)));

    const hash = sha256((prevHash ?? '') + canonical({ id, date, desc, legs, seq }));
    db.prepare(`INSERT INTO entries
      (id,date,description,declared_total,declared_legs,claimed_actor,idempotency_key,
       created_at,prev_hash,hash,seq) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, date, desc, BigInt(declaredTotal), BigInt(declaredLegs), actor, key,
           '2026-08-08T00:00:00Z', prevHash, hash, BigInt(seq));
    db.prepare('INSERT INTO chain_head (seq,hash,recorded_at) VALUES (?,?,?)')
      .run(BigInt(seq), hash, '2026-08-08T00:00:00Z');
    db.exec('COMMIT');
    return { seq, hash };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// A standard balanced entry
const GOOD = {
  id: 'e1', date: '2026-08-08', desc: 'Sales revenue',
  legs: [
    { account: 'Assets:Bank:Checking', side: 'debit',  amount: 500000 },
    { account: 'Income:Sales',  side: 'credit', amount: 500000 },
  ],
  declaredTotal: 500000, declaredLegs: 2,
};

console.log('\n\x1b[1mA. Happy path\x1b[0m');
{
  const db = freshDb();
  accepts('A1 a balanced entry can be posted', () => post(db, GOOD));
  eq('A2 the ledger has 1 entry', db.prepare('SELECT COUNT(*) c FROM entries').get().c, 1);
  eq('A3 global debit/credit difference is 0',
     Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE -amount END),0) d
                        FROM v_postings`).get().d), 0);
  const tb = db.prepare('SELECT * FROM v_trial_balance').get();
  eq('A4 trial balance total debits', Number(tb.total_debits), 500000);
  eq('A5 trial balance total credits', Number(tb.total_credits), 500000);
  const bal = db.prepare("SELECT balance FROM v_balances WHERE account_id='Assets:Bank:Checking'").get();
  eq('A6 bank account balance (asset, debit is positive)', Number(bal.balance), 500000);
  const inc = db.prepare("SELECT balance FROM v_balances WHERE account_id='Income:Sales'").get();
  eq('A7 income account balance (income, credit is positive)', Number(inc.balance), 500000);
  eq('A8 no orphan legs', db.prepare('SELECT COUNT(*) c FROM v_orphan_postings').get().c, 0);
}

console.log('\n\x1b[1mB. Typical LLM mistakes must be caught by the DB layer\x1b[0m');
{
  const db = freshDb();
  rejects('B1 debits and credits do not balance', () => post(db, { ...GOOD, id: 'b1',
    legs: [{ account: 'Assets:Bank:Checking', side: 'debit', amount: 500000 },
           { account: 'Income:Sales',  side: 'credit', amount: 499900 }] }));

  rejects('B2 declared total is wrong', () => post(db, { ...GOOD, id: 'b2', declaredTotal: 499900 }));

  rejects('B3 declared leg count does not match (missing row)', () => post(db, { ...GOOD, id: 'b3', declaredLegs: 3 }));

  rejects('B4 single-leg entry (not double-entry)', () => post(db, { ...GOOD, id: 'b4',
    legs: [{ account: 'Assets:Bank:Checking', side: 'debit', amount: 500000 }],
    declaredLegs: 1 }));

  rejects('B5 negative amount (direction should be expressed by side)', () => post(db, { ...GOOD, id: 'b5',
    legs: [{ account: 'Assets:Bank:Checking', side: 'debit', amount: -500000 },
           { account: 'Income:Sales',  side: 'credit', amount: -500000 }],
    declaredTotal: -500000 }));

  rejects('B6 zero amount', () => post(db, { ...GOOD, id: 'b6',
    legs: [{ account: 'Assets:Bank:Checking', side: 'debit', amount: 0 },
           { account: 'Income:Sales',  side: 'credit', amount: 0 }],
    declaredTotal: 0 }));

  rejects('B7 account does not exist (foreign key)', () => post(db, { ...GOOD, id: 'b7',
    legs: [{ account: 'Assets:Bank:UOD', side: 'debit', amount: 500000 },
           { account: 'Income:Sales',  side: 'credit', amount: 500000 }] }));

  rejects('B8 invalid side value', () => post(db, { ...GOOD, id: 'b8',
    legs: [{ account: 'Assets:Bank:Checking', side: 'dr', amount: 500000 },
           { account: 'Income:Sales',  side: 'credit', amount: 500000 }] }));

  eq('B9 after all of the above are rejected, the ledger is still empty',
     db.prepare('SELECT COUNT(*) c FROM entries').get().c, 0);
  eq('B10 and no orphan legs are left behind (failed writes roll back completely)',
     db.prepare('SELECT COUNT(*) c FROM postings').get().c, 0);
}

console.log('\n\x1b[1mC. Bypassing the CLI to edit the DB directly must be blocked\x1b[0m');
{
  const db = freshDb();
  post(db, GOOD);
  rejects('C1 modify a posting amount',   () => db.exec('UPDATE postings SET amount = 1'));
  rejects('C2 delete a sealed posting', () => db.exec("DELETE FROM postings WHERE entry_id='e1'"));
  rejects('C3 modify an entry description',        () => db.exec("UPDATE entries SET description='edited'"));
  rejects('C4 delete an entry',            () => db.exec('DELETE FROM entries'));
  rejects('C5 forge a hash',          () => db.exec("UPDATE entries SET hash='forged'"));
  rejects('C6 modify the chain head',            () => db.exec("UPDATE chain_head SET hash='forged'"));
  rejects('C7 delete the chain head (truncation attack)',  () => db.exec('DELETE FROM chain_head'));
  rejects('C8 append a leg after sealing', () =>
    db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)')
      .run('e1', 3, 'Income:Sales', 'credit', 100n));
  rejects('C9 delete an account (still referenced by an entry)', () => db.exec("DELETE FROM accounts WHERE id='Assets:Bank:Checking'"));
  eq('C10 ledger is intact after the attack', db.prepare('SELECT COUNT(*) c FROM entries').get().c, 1);
  eq('C11 debits and credits still balance after the attack',
     Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE -amount END),0) d
                        FROM v_postings`).get().d), 0);
}

console.log('\n\x1b[1mD. Audit chain\x1b[0m');
{
  const db = freshDb();
  const r1 = post(db, GOOD);
  const r2 = post(db, { ...GOOD, id: 'e2', desc: 'Second entry' });
  eq('D1 chain sequence number increments', r2.seq, 2);
  const e2 = db.prepare("SELECT prev_hash FROM entries WHERE id='e2'").get();
  eq("D2 the second entry's prev_hash points to the first", e2.prev_hash, r1.hash);

  // Forge an entry with a non-contiguous seq — a queue-jumping attack
  rejects('D3 chain sequence number skips (queue-jumping forgery)', () => {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)')
        .run('gap', 1, 'Assets:Cash', 'debit', 100n);
      db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)')
        .run('gap', 2, 'Income:Sales', 'credit', 100n);
      db.prepare(`INSERT INTO entries (id,date,description,declared_total,declared_legs,
                  created_at,prev_hash,hash,seq) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('gap', '2026-08-09', 'jumped the queue', 100n, 2n, '2026-08-08T00:00:00Z', r2.hash, 'h', 99n);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  rejects('D4 prev_hash does not chain up (broken-chain forgery)', () => {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)')
        .run('brk', 1, 'Assets:Cash', 'debit', 100n);
      db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)')
        .run('brk', 2, 'Income:Sales', 'credit', 100n);
      db.prepare(`INSERT INTO entries (id,date,description,declared_total,declared_legs,
                  created_at,prev_hash,hash,seq) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('brk', '2026-08-09', 'broken chain', 100n, 2n, '2026-08-08T00:00:00Z', 'wrong-prev', 'h', 3n);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });
}

console.log('\n\x1b[1mE. Idempotency\x1b[0m');
{
  const db = freshDb();
  post(db, { ...GOOD, key: 'idem-1' });
  rejects('E1 the same idempotency_key cannot post twice', () =>
    post(db, { ...GOOD, id: 'e-dup', key: 'idem-1' }));
  accepts('E2 a different key posts normally', () =>
    post(db, { ...GOOD, id: 'e2', key: 'idem-2' }));
  eq('E3 the ledger has 2 entries, not 3',
     db.prepare('SELECT COUNT(*) c FROM entries').get().c, 2);
}

console.log('\n\x1b[1mF. Lock date and closed accounts\x1b[0m');
{
  const db = freshDb();
  db.exec("INSERT INTO meta (key,value) VALUES ('lock_date','2026-07-31')");
  rejects('F1 posting into a locked period (agent time travel)', () =>
    post(db, { ...GOOD, id: 'f1', date: '2026-07-15' }));
  accepts('F2 posting after the lock date works normally', () =>
    post(db, { ...GOOD, id: 'f2', date: '2026-08-01' }));

  db.exec("UPDATE accounts SET closed_at='2026-08-05' WHERE id='Assets:Cash'");
  rejects('F3 posting into a closed account', () => post(db, { ...GOOD, id: 'f3',
    legs: [{ account: 'Assets:Cash',  side: 'debit',  amount: 100 },
           { account: 'Income:Sales', side: 'credit', amount: 100 }],
    declaredTotal: 100 }));
}

console.log('\n\x1b[1mG. Account name shape\x1b[0m');
{
  const db = freshDb();
  const openAcct = (id) => db.prepare('INSERT INTO accounts (id,type,opened_at) VALUES (?,?,?)')
                             .run(id, 'asset', '2026-01-01');
  accepts('G1 valid: Assets:Bank:DBS',  () => openAcct('Assets:Bank:DBS'));
  rejects('G2 invalid: leading colon',          () => openAcct(':Assets'));
  rejects('G3 invalid: trailing colon',          () => openAcct('Assets:'));
  rejects('G4 invalid: empty segment ::',           () => openAcct('Assets::Bank'));
  rejects('G5 invalid: contains a space',            () => openAcct('Assets:My Bank'));
}

console.log('\n\x1b[1mH. Document archiving\x1b[0m');
{
  const db = freshDb();
  post(db, GOOD);
  const sha = sha256('fake-pdf-bytes');
  accepts('H1 archive a document', () =>
    db.prepare('INSERT INTO documents (sha256,bytes,mime,orig_name,rel_path,stored_at) VALUES (?,?,?,?,?,?)')
      .run(sha, 1024n, 'application/pdf', 'invoice.pdf', `${sha.slice(0,2)}/${sha.slice(2,4)}/${sha}.pdf`, '2026-08-08T00:00:00Z'));
  accepts('H2 link it to an entry', () =>
    db.prepare('INSERT INTO entry_documents (entry_id,sha256,kind,linked_at) VALUES (?,?,?,?)')
      .run('e1', sha, 'invoice', '2026-08-08T00:00:00Z'));
  rejects('H3 archived documents cannot be modified', () => db.exec("UPDATE documents SET bytes = 1"));
  rejects('H4 archived documents cannot be deleted', () => db.exec('DELETE FROM documents'));
  accepts('H5 re-archiving the same file is blocked by the PK (content-addressed dedup)', () => {
    try {
      db.prepare('INSERT INTO documents (sha256,bytes,rel_path,stored_at) VALUES (?,?,?,?)')
        .run(sha, 1024n, 'other/path', '2026-08-08T00:00:00Z');
      throw new Error('expected a conflict');
    } catch (e) {
      if (!/UNIQUE|PRIMARY/i.test(e.message)) throw e;
    }
  });
  const back = db.prepare(`SELECT e.id FROM entries e
    JOIN entry_documents ed ON ed.entry_id = e.id WHERE ed.sha256 = ?`).get(sha);
  eq('H6 can trace back from the document to the entry (so they can be reconciled later)', back.id, 'e1');
}

console.log('\n\x1b[1mI. Orphan legs can be cleaned up (failed writes leave no permanent garbage)\x1b[0m');
{
  const db = freshDb();
  db.prepare('INSERT INTO postings (entry_id,seq,account_id,side,amount) VALUES (?,?,?,?,?)')
    .run('orphan', 1, 'Assets:Cash', 'debit', 1n);
  eq('I1 unsealed legs are invisible in v_postings',
     db.prepare('SELECT COUNT(*) c FROM v_postings').get().c, 0);
  eq('I2 but v_orphan_postings can find them',
     db.prepare('SELECT COUNT(*) c FROM v_orphan_postings').get().c, 1);
  accepts('I3 orphan legs can be cleaned up', () => db.exec("DELETE FROM postings WHERE entry_id='orphan'"));
}

console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
