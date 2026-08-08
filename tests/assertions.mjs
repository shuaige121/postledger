// Balance assertions and schema migration.
//
// The assertion is the only check in this system that looks outward. Everything
// else proves the ledger is internally consistent; this proves it still matches
// something somebody confirmed against reality. The decisive test is D: the
// hash chain, the trial balance and the accounting identity ALL pass on a book
// that is missing an entry, and only the assertion catches it.
//
// Run: node tests/assertions.mjs

import { Ledger, PostledgerError } from '../src/ledger.ts';
import { migrate, CURRENT_SCHEMA_VERSION } from '../src/migrations.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const has = (n, hay, needle) =>
  (String(hay).includes(needle) ? ok(n, `contains "${needle}"`) : bad(n, `missing "${needle}"`));
const rejects = (n, code, fn) => {
  try { fn(); bad(n, 'should have been rejected'); }
  catch (e) {
    if (e instanceof PostledgerError && (!code || e.code === code)) ok(n, e.code);
    else bad(n, `expected ${code}, got ${e.code ?? e.constructor.name}: ${e.message}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'postledger-assert-'));
let n = 0;
function book() {
  const L = Ledger.create(join(dir, `b${n++}.db`), { name: 'T', currency: 'USD' });
  L.openAccount('Assets:Bank', 'asset');
  L.openAccount('Assets:Bank:Savings', 'asset');
  L.openAccount('Income:Sales', 'income');
  return L;
}
const sale = (L, key, date, amt, account = 'Assets:Bank') => L.post({
  idempotencyKey: key, date, description: 'sale',
  legs: [{ account, side: 'debit', amount: amt },
         { account: 'Income:Sales', side: 'credit', amount: amt }],
  expectedTotal: amt,
});

console.log('\n\x1b[1mA. Recording a confirmation\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-07-20', '1000.00');
  const a = L.assertBalance('Assets:Bank', '1000.00', { date: '2026-07-31', note: 'July statement' });
  eq('A1 an accurate figure is accepted', a.ok, true);
  eq('A2 recorded against the date given', a.date, '2026-07-31');
  eq('A3 and it is listed', L.assertions().count, 1);
  eq('A4 with the note that says what it was checked against',
     L.assertions().assertions[0].note, 'July statement');
  eq('A5 verify passes', L.verify({ documents: false }).ok, true);
  L.close();
}

console.log('\n\x1b[1mB. A figure that disagrees is refused, not recorded\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-07-20', '1000.00');
  try {
    L.assertBalance('Assets:Bank', '1200.00', { date: '2026-07-31' });
    bad('B1 mismatched figure rejected', 'it was accepted');
  } catch (e) {
    eq('B1 mismatched figure rejected', e.code, 'ASSERTION_FAILED');
    eq('B2 and it states the gap exactly', e.detail.difference, '200.00');
    eq('B3 showing what the books actually hold', e.detail.in_books, '1000.00');
    has('B4 and refuses to record a known-false claim', e.hint, 'Do not record an assertion you know to be false');
  }
  eq('B5 nothing was written', L.assertions().count, 0);
  L.close();
}

console.log('\n\x1b[1mC. Sub-account coverage\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-07-20', '1000.00', 'Assets:Bank');
  sale(L, 'p2', '2026-07-21', '250.00', 'Assets:Bank:Savings');
  eq('C1 the parent alone', L.balance('Assets:Bank').balance, '1000.00');
  eq('C2 asserting the parent alone works',
     L.assertBalance('Assets:Bank', '1000.00', { date: '2026-07-31' }).ok, true);
  eq('C3 asserting the subtree covers descendants',
     L.assertBalance('Assets:Bank', '1250.00', { date: '2026-07-31', subtree: true }).ok, true);
  rejects('C4 and the subtree figure is checked too', 'ASSERTION_FAILED',
    () => L.assertBalance('Assets:Bank', '1000.00', { date: '2026-07-31', subtree: true }));
  L.close();
}

console.log('\n\x1b[1mD. THE point: a missed entry, posted later\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-07-20', '1000.00');
  L.assertBalance('Assets:Bank', '1000.00', { date: '2026-07-31', note: 'July statement' });
  eq('D1 everything passes at first', L.verify({ documents: false }).ok, true);

  // An entry that was missed in July and only noticed in August.
  sale(L, 'missed', '2026-07-15', '500.00');

  const v = L.verify({ documents: false });
  eq('D2 the assertion now fails', v.ok, false);
  eq('D3 and names the assertion',
     v.problems.some((p) => p.check === 'assertions'), true);
  has('D4 explaining what happened',
      JSON.stringify(v.problems), 'posted into a period that had already been confirmed');

  // The decisive comparison: every other check is blind to this.
  eq('D5 the hash chain sees nothing wrong',
     L.verify({ balance: false, documents: false, assertions: false }).ok, true);
  eq('D6 the trial balance still balances', L.trialBalance().balanced, true);
  eq('D7 the accounting identity still holds', L.balanceSheet().identity.holds, true);
  ok('D8 ↑ without assertions this book looks perfect and is wrong');
  L.close();
}

console.log('\n\x1b[1mE. Generating a starting snapshot\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-07-20', '1000.00');
  sale(L, 'p2', '2026-07-21', '250.00', 'Assets:Bank:Savings');
  const g = L.generateAssertions({ note: 'opening snapshot' });
  eq('E1 one per funded asset account', g.generated, 2);
  eq('E2 income accounts are not asserted by default',
     g.assertions.some((a) => a.account.startsWith('Income')), false);
  eq('E3 all of them verify', L.verify({ documents: false }).ok, true);
  has('E4 and it warns that a snapshot only means something if reconciled first',
      g.note, 'reconciled against reality first');
  L.close();
}

console.log('\n\x1b[1mF. Assertions are append-only\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-07-20', '1000.00');
  L.assertBalance('Assets:Bank', '1000.00', { date: '2026-07-31' });
  const path = L.path;
  L.close();
  const raw = new DatabaseSync(path);
  const refuses = (label, sql) => {
    try { raw.exec(sql); bad(label, 'it was allowed'); }
    catch (e) { ok(label, 'refused: ' + e.message.replace(/^.*postledger: /, '')); }
  };
  refuses('F1 an assertion cannot be edited', "UPDATE assertions SET amount = 1");
  refuses('F2 an assertion cannot be deleted', 'DELETE FROM assertions');
  raw.close();
}

console.log('\n\x1b[1mG. Knowing what to reconcile next\x1b[0m');
{
  const L = book();
  sale(L, 'p1', '2026-01-10', '1000.00');
  L.assertBalance('Assets:Bank', '1000.00', { date: '2026-01-31' });
  eq('G1 nothing stale right after asserting', L.staleAssertions().ok, true);

  sale(L, 'p2', '2026-06-10', '500.00');
  const st = L.staleAssertions({ withinDays: 30 });
  eq('G2 months of activity since the last check is flagged', st.ok, false);
  eq('G3 naming the account', st.stale[0].account, 'Assets:Bank');
  eq('G4 and how many entries have landed since', st.stale[0].entries_since, 1);
  has('G5 with the reason it matters', st.note, 'looks tended but is not');
  L.close();
}

console.log('\n\x1b[1mH. A book made by an older version opens and upgrades\x1b[0m');
{
  // Build a v1 book by hand: the schema as it shipped, without assertions.
  const p = join(dir, 'legacy.db');
  const raw = new DatabaseSync(p);
  raw.exec(readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8'));
  const ins = raw.prepare('INSERT INTO meta (key,value) VALUES (?,?)');
  for (const [k, v] of [['book_name', 'Legacy'], ['currency', 'USD'],
                        ['currency_decimals', '2'], ['schema_version', '1'],
                        ['created_at', '2026-01-01T00:00:00Z']]) ins.run(k, v);
  const before = raw.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='assertions'").get();
  raw.close();
  eq('H1 the old book has no assertions table', Number(before.c), 0);

  const L = Ledger.open(p);          // opening is what migrates
  eq('H2 opening upgrades it', L.info().ok, true);
  L.openAccount('Assets:Bank', 'asset');
  L.openAccount('Income:Sales', 'income');
  sale(L, 'p1', '2026-07-20', '1000.00');
  eq('H3 and assertions work on it',
     L.assertBalance('Assets:Bank', '1000.00', { date: '2026-07-31' }).ok, true);
  L.close();

  const after = new DatabaseSync(p);
  eq('H4 schema_version was bumped',
     Number(after.prepare("SELECT value v FROM meta WHERE key='schema_version'").get().v),
     CURRENT_SCHEMA_VERSION);
  after.close();

  // Migration must be safe to run repeatedly — a crash mid-upgrade should be
  // recoverable by simply opening the file again.
  const again = new DatabaseSync(p);
  const r = migrate(again);
  eq('H5 re-running the migration changes nothing', r.applied.length, 0);
  again.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
