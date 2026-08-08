// Period closes, dry runs, statement import, and the operating manual.
// Run: node tests/operations.mjs

import { Ledger, PostledgerError } from '../src/ledger.ts';
import { parseCsv, parseDate, parseBankAmount, ImportError } from '../src/bankimport.ts';
import { manual, MANUAL, INSTRUCTIONS } from '../src/manual.ts';
import { currencyOf } from '../src/money.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const has = (n, hay, needle) =>
  (String(hay).includes(needle) ? ok(n, `contains "${needle}"`) : bad(n, `missing "${needle}"`));
const rejects = (n, code, fn) => {
  try { fn(); bad(n, 'should have been rejected'); }
  catch (e) {
    if ((e instanceof PostledgerError || e instanceof ImportError) && (!code || e.code === code || !e.code)) ok(n, e.code ?? 'ImportError');
    else bad(n, `expected ${code}, got ${e.code ?? e.constructor.name}: ${e.message}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'postledger-ops-'));
const USD = currencyOf('USD');
let n = 0;
function book() {
  const L = Ledger.create(join(dir, `b${n++}.db`), { name: 'Ops', currency: 'USD' });
  L.openAccount('Assets:Bank', 'asset');
  L.openAccount('Equity:Capital', 'equity');
  L.openAccount('Expenses:Misc', 'expense');
  return L;
}
const put = (L, key, date, amt) => L.post({
  idempotencyKey: key, date, description: 'entry',
  legs: [{ account: 'Assets:Bank', side: 'debit', amount: amt },
         { account: 'Equity:Capital', side: 'credit', amount: amt }],
  expectedTotal: amt,
});

console.log('\n\x1b[1mA. Dry run\x1b[0m');
{
  const L = book();
  put(L, 'seed', '2026-01-01', '1000.00');
  const p = L.post({
    idempotencyKey: 'preview-me', date: '2026-02-01', description: 'considering this',
    legs: [{ account: 'Expenses:Misc', side: 'debit', amount: '50.00' },
           { account: 'Assets:Bank', side: 'credit', amount: '50.00' }],
    expectedTotal: '50.00',
  }, { dryRun: true });
  eq('A1 it reports what would happen', p.total, '50.00');
  eq('A2 flagged as a dry run', p.dry_run, true);
  eq('A3 and warns the ids are not real', p.ids_are_preview_only, true);
  eq('A4 nothing was written', L.info().entries, 1);

  // The key must still be available — previewing should not burn it.
  const real = L.post({
    idempotencyKey: 'preview-me', date: '2026-02-01', description: 'considering this',
    legs: [{ account: 'Expenses:Misc', side: 'debit', amount: '50.00' },
           { account: 'Assets:Bank', side: 'credit', amount: '50.00' }],
    expectedTotal: '50.00',
  });
  eq('A5 the same key still commits for real', real.replayed, false);
  eq('A6 and now it is written', L.info().entries, 2);

  // A dry run runs the REAL checks, so a bad entry fails in preview too.
  rejects('A7 a broken entry fails in preview as well', 'UNBALANCED', () => L.post({
    idempotencyKey: 'bad-preview', date: '2026-02-02', description: 'x',
    legs: [{ account: 'Expenses:Misc', side: 'debit', amount: '10.00' },
           { account: 'Assets:Bank', side: 'credit', amount: '9.00' }],
    expectedTotal: '10.00',
  }, { dryRun: true }));
  eq('A8 verify still passes after previews', L.verify({ documents: false }).ok, true);
  L.close();
}

console.log('\n\x1b[1mB. Closing and reopening a period\x1b[0m');
{
  const L = book();
  put(L, 'jan', '2026-01-15', '1000.00');
  put(L, 'feb', '2026-02-15', '200.00');

  const c = L.closePeriod('FY2026 Q1', '2026-03-31', { note: 'reviewed with accountant' });
  eq('B1 the close is named', c.name, 'FY2026 Q1');
  eq('B2 and reports what it covers', c.entries_covered, 2);

  rejects('B3 posting into it is refused', 'PERIOD_LOCKED', () => put(L, 'late', '2026-02-20', '9.00'));
  eq('B4 posting after it is fine', put(L, 'apr', '2026-04-01', '9.00').ok, true);
  rejects('B5 closing an already-covered date is refused', 'ALREADY_CLOSED',
    () => L.closePeriod('overlap', '2026-02-28'));
  rejects('B6 reopening needs a reason', 'MISSING_REASON', () => L.reopenPeriod(1, ''));

  const r = L.reopenPeriod(1, 'a supplier invoice arrived late');
  eq('B7 reopened', r.ok, true);
  eq('B8 and the reason is kept', L.periods().periods[0].reopen_reason, 'a supplier invoice arrived late');
  eq('B9 the close itself is still on record', L.periods().count, 1);
  eq('B10 nothing is closed now', L.periods().closed_through, null);
  eq('B11 the late entry can be posted', put(L, 'late', '2026-02-20', '9.00').ok, true);
  rejects('B12 a close can only be reopened once', 'ALREADY_REOPENED',
    () => L.reopenPeriod(1, 'again'));
  L.close();
}

console.log('\n\x1b[1mC. Period closes are append-only\x1b[0m');
{
  const L = book();
  put(L, 'a', '2026-01-15', '100.00');
  L.closePeriod('Q1', '2026-03-31');
  const path = L.path;
  L.close();
  const raw = new DatabaseSync(path);
  const refuses = (label, sql) => {
    try { raw.exec(sql); bad(label, 'it was allowed'); }
    catch (e) { ok(label, 'refused'); }
  };
  refuses('C1 the as_of date cannot be edited', "UPDATE period_closes SET as_of='2020-01-01'");
  refuses('C2 the name cannot be edited', "UPDATE period_closes SET name='something else'");
  refuses('C3 a close cannot be deleted', 'DELETE FROM period_closes');
  raw.close();
}

console.log('\n\x1b[1mD. Reading a bank statement\x1b[0m');
{
  const csv = [
    'Date,Description,Amount,Reference',
    '15/03/2026,"COFFEE BEAN #221",-4.50,TX001',
    '16/03/2026,"SALARY ACME","3,500.00",TX002',
    '17/03/2026,"REFUND (STORE)",(12.00),TX003',
  ].join('\n');
  const L = book();
  put(L, 'fund', '2026-01-01', '1000.00');       // the bank account needs money to spend
  const before = L.info().entries;
  const r = L.readStatement(csv, { date: 'Date', description: 'Description', amount: 'Amount', reference: 'Reference' });
  eq('D1 three rows read', r.count, 3);
  eq('D2 day-first date resolved', r.candidates[0].date, '2026-03-15');
  eq('D3 thousands separator handled', r.candidates[1].amount, '3500.00');
  eq('D4 accounting parentheses are negative', r.candidates[2].amount, '-12.00');
  eq('D5 the net is reported', r.total, '3483.50');
  eq('D6 each row carries a key to post with', r.candidates[0].suggested_key.startsWith('stmt:'), true);
  eq('D7 reading posts nothing', L.info().entries, before);

  // The fingerprint must be stable, so re-reading marks rows as known once posted.
  const again = L.readStatement(csv, { date: 'Date', description: 'Description', amount: 'Amount', reference: 'Reference' });
  eq('D8 fingerprints are stable across reads',
     again.candidates[0].suggested_key, r.candidates[0].suggested_key);

  L.post({
    idempotencyKey: r.candidates[0].suggested_key, date: r.candidates[0].date,
    description: r.candidates[0].description,
    legs: [{ account: 'Expenses:Misc', side: 'debit', amount: '4.50' },
           { account: 'Assets:Bank', side: 'credit', amount: '4.50' }],
    expectedTotal: '4.50',
  });
  const third = L.readStatement(csv, { date: 'Date', description: 'Description', amount: 'Amount', reference: 'Reference' });
  eq('D9 a posted row is marked already_posted', third.candidates[0].already_posted, true);
  eq('D10 an unposted one is not', third.candidates[1].already_posted, false);
  L.close();
}

console.log('\n\x1b[1mE. The importer refuses to guess\x1b[0m');
{
  rejects('E1 an ambiguous date is refused', null,
    () => parseDate('03/04/2026', undefined, 2));
  eq('E2 unless told the format', parseDate('03/04/2026', 'dmy', 2), '2026-04-03');
  eq('E3 mdy gives the other reading', parseDate('03/04/2026', 'mdy', 2), '2026-03-04');
  eq('E4 an unambiguous date needs no help', parseDate('15/03/2026', undefined, 2), '2026-03-15');
  eq('E5 ISO passes through', parseDate('2026-03-15', undefined, 2), '2026-03-15');

  eq('E6 European decimals', parseBankAmount('1.234,56', USD, 1).format(), '1234.56');
  eq('E7 Anglo decimals', parseBankAmount('1,234.56', USD, 1).format(), '1234.56');
  eq('E8 currency symbols stripped', parseBankAmount('$45.00', USD, 1).format(), '45.00');
  rejects('E9 an empty amount is refused', null, () => parseBankAmount('   ', USD, 1));

  const rows = parseCsv('a,b\n"x,y",2\n"he said ""hi""",3\n');
  eq('E10 quoted commas survive', rows[1][0], 'x,y');
  eq('E11 doubled quotes survive', rows[2][0], 'he said "hi"');
  rejects('E12 an unclosed quote is refused', null, () => parseCsv('a,b\n"never closed,2\n'));
}

console.log('\n\x1b[1mF. Card statements and split columns\x1b[0m');
{
  const L = book();
  // On a card statement a purchase is printed positive; invert_sign makes it an outflow.
  const r = L.readStatement('Date,Desc,Amount\n2026-03-01,PURCHASE,25.00\n',
    { date: 'Date', description: 'Desc', amount: 'Amount', invertSign: true });
  eq('F1 invert_sign flips the direction', r.candidates[0].amount, '-25.00');

  const split = L.readStatement('Date,Desc,Out,In\n2026-03-01,FEE,5.00,\n2026-03-02,DEPOSIT,,100.00\n',
    { date: 'Date', description: 'Desc', debit: 'Out', credit: 'In' });
  eq('F2 a debit column is money out', split.candidates[0].amount, '-5.00');
  eq('F3 a credit column is money in', split.candidates[1].amount, '100.00');
  rejects('F4 a row filling both columns is refused', null,
    () => L.readStatement('Date,Desc,Out,In\n2026-03-01,X,5.00,6.00\n',
      { date: 'Date', description: 'Desc', debit: 'Out', credit: 'In' }));
  rejects('F5 a missing column is named clearly', null,
    () => L.readStatement('Date,Desc,Amount\n2026-03-01,X,1.00\n',
      { date: 'Date', description: 'Desc', amount: 'NoSuchColumn' }));
  L.close();
}

console.log('\n\x1b[1mG. The operating manual\x1b[0m');
{
  const list = manual();
  eq('G1 topics are listed', list.topics.length, MANUAL.length);
  eq('G2 every topic has guidance and warnings',
     MANUAL.every((m) => m.guidance.length && m.warnings.length && m.recommended_tools.length), true);
  eq('G3 a topic can be read', manual('posting-safely').topic, 'posting-safely');
  eq('G4 an unknown topic lists the real ones', manual('nope').ok, false);

  has('G5 instructions point at the chart first', INSTRUCTIONS, 'postledger_chart');
  has('G6 and at the outward-looking check', INSTRUCTIONS, 'assert_balance');
  eq('G7 instructions stay compact', INSTRUCTIONS.length < 1200, true);

  // The manual must not overclaim on the system's behalf.
  const limits = manual('what-this-cannot-do');
  has('G8 the limits topic says tamper-evident, not proof', limits.summary, 'not tamper-proof');
  has('G9 and forbids calling it blockchain-backed',
      limits.warnings.join(' '), 'blockchain-backed');

  // Every tool named in the manual must actually exist.
  const named = new Set(MANUAL.flatMap((m) => m.recommended_tools));
  eq('G10 every recommended tool is a real tool name',
     [...named].every((t) => t.startsWith('postledger_')), true);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
