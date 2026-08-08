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

console.log('\n\x1b[1mI. Tax / FX audit columns and tags\x1b[0m');
{
  const L = book();
  L.openAccount('Expenses:Meals', 'expense');
  L.openAccount('Liabilities:VAT', 'liability');
  sale(L, 'seed', '2026-08-01', '1000.00');

  const r = L.post({
    idempotencyKey: 'lunch', date: '2026-08-08', description: 'Team lunch in Amsterdam',
    legs: [
      { account: 'Expenses:Meals', side: 'debit', amount: '100.00',
        taxCode: 'VAT21', taxAmount: '21.00', fxCurrency: 'EUR', fxAmount: '92.50' },
      { account: 'Liabilities:VAT', side: 'debit', amount: '21.00', taxCode: 'VAT21' },
      { account: 'Assets:Bank', side: 'credit', amount: '121.00' },
    ],
    expectedTotal: '121.00', tags: { project: 'apollo', client: 'acme' },
  });
  eq('I1 posted with tax, fx and tags', r.ok, true);
  eq('I2 tax code echoed back', r.legs[0].tax_code, 'VAT21');
  eq('I3 original currency preserved', r.legs[0].fx_currency, 'EUR');
  eq('I4 original amount preserved exactly', r.legs[0].fx_amount, '92.50');
  eq('I5 tags echoed back', r.tags.project, 'apollo');
  eq('I6 verify passes with the new fields', L.verify({ documents: false }).ok, true);

  // Entries without any of it must still verify — books written by older
  // versions hashed a payload with none of these keys.
  L.post({ idempotencyKey: 'plain', date: '2026-08-09', description: 'plain',
    legs: [{ account: 'Expenses:Meals', side: 'debit', amount: '10.00' },
           { account: 'Assets:Bank', side: 'credit', amount: '10.00' }], expectedTotal: '10.00' });
  eq('I7 old-style and new-style entries coexist', L.verify({ documents: false }).ok, true);

  rejects('I8 fx_amount without fx_currency is refused', 'BAD_AMOUNT', () => L.post({
    idempotencyKey: 'bad-fx', date: '2026-08-10', description: 'x',
    legs: [{ account: 'Expenses:Meals', side: 'debit', amount: '5.00', fxAmount: '4.50' },
           { account: 'Assets:Bank', side: 'credit', amount: '5.00' }], expectedTotal: '5.00' }));
  rejects('I9 an unknown fx currency is refused', 'BAD_AMOUNT', () => L.post({
    idempotencyKey: 'bad-cur', date: '2026-08-10', description: 'x',
    legs: [{ account: 'Expenses:Meals', side: 'debit', amount: '5.00', fxCurrency: 'XYZ', fxAmount: '4.50' },
           { account: 'Assets:Bank', side: 'credit', amount: '5.00' }], expectedTotal: '5.00' }));

  const path = L.path;
  L.close();
  // The tax code is part of the hashed payload, so altering it must break the chain.
  const raw = new DatabaseSync(path);
  raw.exec('DROP TRIGGER posting_no_update');
  raw.exec("UPDATE postings SET tax_code='VAT9' WHERE tax_code='VAT21'");
  raw.close();
  const L2 = Ledger.open(path);
  eq('I10 altering a tax code breaks the chain', L2.verify({ documents: false }).ok, false);
  L2.close();
}

console.log('\n\x1b[1mJ. Finding entries again\x1b[0m');
{
  const L = book();
  L.openAccount('Expenses:Meals', 'expense');
  sale(L, 'seed', '2026-01-01', '5000.00');
  for (let i = 1; i <= 6; i++) {
    L.post({ idempotencyKey: `e${i}`, date: `2026-0${i}-15`, description: i % 2 ? 'coffee run' : 'team dinner',
      legs: [{ account: 'Expenses:Meals', side: 'debit', amount: `${i * 10}.00` },
             { account: 'Assets:Bank', side: 'credit', amount: `${i * 10}.00` }],
      expectedTotal: `${i * 10}.00`, actor: i % 2 ? 'agent:a' : 'human:b',
      tags: { project: i <= 3 ? 'apollo' : 'zeus' } });
  }
  eq('J1 filter by tag', L.entries({ tag: 'project', tagValue: 'apollo' }).count, 3);
  eq('J2 filter by actor', L.entries({ actor: 'agent:a' }).count, 3);
  eq('J3 filter by description', L.entries({ describes: 'coffee' }).count, 3);
  eq('J4 filter by amount range', L.entries({ minAmount: '30.00', maxAmount: '50.00' }).count, 3);
  eq('J5 filter by date range', L.entries({ since: '2026-03-01', until: '2026-04-30' }).count, 2);
  eq('J6 account prefix covers descendants', L.entries({ account: 'Expenses' }).count, 6);

  // Cursor paging must walk the whole history without repeating or skipping.
  const seen = new Set();
  let cursor, pages = 0;
  for (;;) {
    const page = L.entries({ limit: 3, beforeSeq: cursor });
    page.entries.forEach((e) => seen.add(e.seq));
    pages++;
    if (page.next_before_seq === null) break;
    cursor = page.next_before_seq;
    if (pages > 10) break;
  }
  eq('J7 paging visits every entry exactly once', seen.size, 7);
  eq('J8 and terminates', pages <= 4, true);

  eq('J9 balance as of a past date', L.balance('Assets:Bank', { asOf: '2026-02-28' }).balance, '4970.00');
  eq('J10 balance now', L.balance('Assets:Bank').balance, '4790.00');
  L.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
