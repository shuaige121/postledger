// Engine tests: idempotency, audit chain, reversal, documents, tamper detection
// Run: node tests/engine.mjs

import { Ledger, PostledgerError } from '../src/ledger.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const rejects = (n, code, fn) => {
  try { fn(); bad(n, 'should have been rejected, but passed'); }
  catch (e) {
    if (e instanceof PostledgerError && (!code || e.code === code)) ok(n, `${e.code}`);
    else bad(n, `expected ${code}, got ${e.code ?? e.constructor.name}: ${e.message}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'postledger-test-'));
const bookPath = join(dir, 'test.db');

function freshBook() {
  if (existsSync(bookPath)) rmSync(bookPath, { force: true });
  for (const s of ['-wal', '-shm']) rmSync(bookPath + s, { force: true });
  const L = Ledger.create(bookPath, { name: 'Test Co', currency: 'SGD' });
  L.openAccount('Assets:Bank:Checking', 'asset');
  L.openAccount('Assets:Cash', 'asset');
  L.openAccount('Income:Sales', 'income');
  L.openAccount('Expenses:Rent', 'expense');
  return L;
}

const ENTRY = (over = {}) => ({
  idempotencyKey: 'k1', date: '2026-08-08', description: 'Sales revenue',
  legs: [
    { account: 'Assets:Bank:Checking', side: 'debit',  amount: '5000.00' },
    { account: 'Income:Sales',  side: 'credit', amount: '5000.00' },
  ],
  expectedTotal: '5000.00',
  ...over,
});

console.log('\n\x1b[1mA. Posting and idempotency\x1b[0m');
{
  const L = freshBook();
  const r1 = L.post(ENTRY());
  eq('A1 first post succeeds', r1.ok, true);
  eq('A2 first post is not a replay', r1.replayed, false);
  eq('A3 total is correct', r1.total, '5000.00');
  eq('A4 returns a chain head (externally anchorable)', typeof r1.chain_head, 'string');

  // same key, same args = replay, never double-post
  const r2 = L.post(ENTRY());
  eq('A5 same key, same args → replayed=true', r2.replayed, true);
  eq('A6 returns the same entry', r2.entry_id, r1.entry_id);
  eq('A7 book still has only 1 entry', L.info().entries, 1);

  // same key, different args = loud error, never silent overwrite
  rejects('A8 same key, changed amount → conflict', 'IDEMPOTENCY_CONFLICT',
    () => L.post(ENTRY({ legs: [
      { account: 'Assets:Bank:Checking', side: 'debit',  amount: '6000.00' },
      { account: 'Income:Sales',  side: 'credit', amount: '6000.00' }], expectedTotal: '6000.00' })));
  eq('A9 book unchanged after conflict', L.info().entries, 1);

  const r3 = L.post(ENTRY({ idempotencyKey: 'k2', description: 'Second entry' }));
  eq('A10 a different key can post a new entry', r3.replayed, false);
  eq('A11 now has 2 entries', L.info().entries, 2);
  L.close();
}

console.log('\n\x1b[1mB. Rejecting unreliable callers (the mistakes LLMs typically make)\x1b[0m');
{
  const L = freshBook();
  rejects('B1 missing idempotency_key',       'MISSING_IDEMPOTENCY_KEY', () => L.post(ENTRY({ idempotencyKey: '' })));
  rejects('B2 date is "yesterday"',            'BAD_DATE',   () => L.post(ENTRY({ date: 'yesterday' })));
  rejects('B3 date is "2026/8/8"',             'BAD_DATE',   () => L.post(ENTRY({ date: '2026/8/8' })));
  rejects('B4 amount is a JSON number',        'BAD_AMOUNT', () => L.post(ENTRY({ legs: [
    { account: 'Assets:Bank:Checking', side: 'debit',  amount: 5000.00 },
    { account: 'Income:Sales',  side: 'credit', amount: 5000.00 }] })));
  rejects('B5 amount has a thousands separator "5,000.00"', 'BAD_AMOUNT', () => L.post(ENTRY({ legs: [
    { account: 'Assets:Bank:Checking', side: 'debit',  amount: '5,000.00' },
    { account: 'Income:Sales',  side: 'credit', amount: '5,000.00' }] })));
  rejects('B6 debits and credits unbalanced',  'UNBALANCED', () => L.post(ENTRY({ legs: [
    { account: 'Assets:Bank:Checking', side: 'debit',  amount: '5000.00' },
    { account: 'Income:Sales',  side: 'credit', amount: '4999.99' }] })));
  rejects('B7 declared total is wrong',        'EXPECTED_TOTAL_MISMATCH', () => L.post(ENTRY({ expectedTotal: '4999.00' })));
  rejects('B8 only one leg',                   'TOO_FEW_LEGS', () => L.post(ENTRY({ legs: [
    { account: 'Assets:Bank:Checking', side: 'debit', amount: '5000.00' }] })));
  rejects('B9 empty description',              'MISSING_DESCRIPTION', () => L.post(ENTRY({ description: '  ' })));

  // invented account — must offer candidates, can't let the model keep guessing
  try {
    L.post(ENTRY({ legs: [
      { account: 'Assets:Bank:UOD', side: 'debit',  amount: '5000.00' },
      { account: 'Income:Sales',  side: 'credit', amount: '5000.00' }] }));
    bad('B10 invented account is rejected', 'passed');
  } catch (e) {
    if (e.code === 'UNKNOWN_ACCOUNT' && e.detail.did_you_mean?.includes('Assets:Bank:Checking')) {
      ok('B10 invented account is rejected and offers a candidate', `did_you_mean: ${e.detail.did_you_mean[0]}`);
    } else bad('B10 invented account is rejected', `${e.code} / ${JSON.stringify(e.detail)}`);
  }

  eq('B11 book is still empty after all rejections', L.info().entries, 0);
  L.close();
}

console.log('\n\x1b[1mC. Balance assertions (catching "wrong account / wrong direction")\x1b[0m');
{
  const L = freshBook();
  L.post(ENTRY());                       // bank +5000
  rejects('C1 balance assertion mismatch → rejected', 'BALANCE_ASSERTION_FAILED', () =>
    L.post(ENTRY({ idempotencyKey: 'c1', expectBalanceAfter: { account: 'Assets:Bank:Checking', balance: '99999.00' } })));
  const r = L.post(ENTRY({ idempotencyKey: 'c2', expectBalanceAfter: { account: 'Assets:Bank:Checking', balance: '10000.00' } }));
  eq('C2 balance assertion correct → passes', r.ok, true);
  eq('C3 bank account balance', L.balance('Assets:Bank:Checking').balance, '10000.00');
  L.close();
}

console.log('\n\x1b[1mD. Trial balance\x1b[0m');
{
  const L = freshBook();
  L.post(ENTRY());
  L.post({ idempotencyKey: 'rent', date: '2026-08-09', description: 'Rent',
    legs: [{ account: 'Expenses:Rent', side: 'debit', amount: '1200.00' },
           { account: 'Assets:Bank:Checking', side: 'credit', amount: '1200.00' }],
    expectedTotal: '1200.00' });
  const tb = L.trialBalance();
  eq('D1 trial balance balances', tb.balanced, true);
  eq('D2 total debits', tb.total_debits, '6200.00');
  eq('D3 total credits', tb.total_credits, '6200.00');
  eq('D4 bank account = 5000 - 1200', L.balance('Assets:Bank:Checking').balance, '3800.00');
  eq('D5 expense account = 1200', L.balance('Expenses:Rent').balance, '1200.00');
  eq('D6 summed by prefix Expenses', L.balanceTree('Expenses').total, '1200.00');
  L.close();
}

console.log('\n\x1b[1mE. Reversal is the only way to correct an entry\x1b[0m');
{
  const L = freshBook();
  const orig = L.post(ENTRY());
  const rev = L.reverse(orig.entry_id, { idempotencyKey: 'rev-1', reason: 'wrong counterparty' });
  eq('E1 reversal succeeds', rev.ok, true);
  eq('E2 bank account zeroed after reversal', L.balance('Assets:Bank:Checking').balance, '0.00');
  eq('E3 original entry still there (history is evidence)', L.info().entries, 2);
  rejects('E4 the same entry cannot be reversed twice', 'ALREADY_REVERSED',
    () => L.reverse(orig.entry_id, { idempotencyKey: 'rev-2', reason: 'once more' }));
  eq('E5 books still balance after reversal', L.trialBalance().balanced, true);
  L.close();
}

console.log('\n\x1b[1mF. Document archiving and reconciliation\x1b[0m');
{
  const L = freshBook();
  const e = L.post(ENTRY());
  const pdf = join(dir, 'invoice.pdf');
  writeFileSync(pdf, 'PDF-CONTENT-v1');

  const a = L.attach(e.entry_id, pdf, 'invoice', { idempotencyKey: 'att-1' });
  eq('F1 archiving succeeds', a.ok, true);
  eq('F2 not deduplicated (first time)', a.deduplicated, false);

  const a2 = L.attach(e.entry_id, pdf, 'invoice', { idempotencyKey: 'att-1' });
  eq('F3 same key replays', a2.replayed, true);

  eq('F4 look up documents from an entry', L.documentsOf(e.entry_id).count, 1);
  eq('F5 look up the entry from a document', L.entriesOfDocument(a.sha256).entries[0].id, e.entry_id);

  const v = L.verify();
  eq('F6 all checks pass', v.ok, true);

  // Swap the archived original — the attack that goes undetected if you store a
  // fingerprint but never re-check it
  const stored = join(L.docsDir, a.rel_path);
  chmodSync(stored, 0o640);
  writeFileSync(stored, 'PDF-CONTENT-TAMPERED');
  const v2 = L.verify();
  eq('F7 verification fails after the original is swapped', v2.ok, false);
  eq('F8 and clearly points to the documents check',
     v2.problems.some((p) => p.check === 'documents' && /replaced/.test(p.problem)), true);
  L.close();
}

console.log('\n\x1b[1mG. Tamper detection (simulating an attacker with root)\x1b[0m');
{
  const L = freshBook();
  L.post(ENTRY());
  L.post(ENTRY({ idempotencyKey: 'g2', description: 'Second entry' }));
  L.post(ENTRY({ idempotencyKey: 'g3', description: 'Third entry' }));
  eq('G1 verification passes after three posts', L.verify().ok, true);
  const headBefore = L.verify().chain_head;
  L.close();

  // attacker DROPs the trigger and edits the DB directly — triggers stop
  // slip-ups, not someone determined
  const raw = new DatabaseSync(bookPath);
  raw.exec('DROP TRIGGER entry_no_update');
  raw.exec("UPDATE entries SET description='tampered' WHERE seq=2");
  raw.close();

  const L2 = Ledger.open(bookPath);
  const v = L2.verify();
  eq('G2 content changed → the hash chain catches it', v.ok, false);
  eq('G3 and pinpoints entry #2',
     v.problems.some((p) => p.check === 'chain' && p.where?.seq === 2), true);
  L2.close();
}

console.log('\n\x1b[1mH. Truncation attack detection\x1b[0m');
{
  const L = freshBook();
  L.post(ENTRY());
  L.post(ENTRY({ idempotencyKey: 'h2', description: 'Second entry' }));
  L.post(ENTRY({ idempotencyKey: 'h3', description: 'Third entry, about to be deleted' }));
  eq('H1 verification passes after three entries', L.verify().ok, true);
  L.close();

  // attacker deletes the last entry and recomputes the chain — what's left
  // is still internally self-consistent
  const raw = new DatabaseSync(bookPath);
  raw.exec('DROP TRIGGER entry_no_delete');
  raw.exec('DROP TRIGGER posting_no_delete');
  raw.exec("DELETE FROM postings WHERE entry_id IN (SELECT id FROM entries WHERE seq=3)");
  raw.exec('DELETE FROM entries WHERE seq=3');
  raw.close();

  const L2 = Ledger.open(bookPath);
  const v = L2.verify();
  eq('H2 verification fails after truncation', v.ok, false);
  eq('H3 and reports the chain was truncated',
     v.problems.some((p) => /truncated/.test(p.problem)), true);
  ok('H4 relies on the chain_head table being longer than entries', `chain_head reaches ${v.problems.find(p=>/truncated/.test(p.problem))?.where?.chain_head_max}, entries only reaches ${v.problems.find(p=>/truncated/.test(p.problem))?.where?.entries_max}`);
  L2.close();
}

console.log('\n\x1b[1mJ. Overdraft policy (allow_negative is enforced, not merely stored)\x1b[0m');
{
  const L = freshBook();
  eq('J1 asset defaults to NOT allowing negative',
     L.openAccount('Assets:Cash2', 'asset').allow_negative, false);
  eq('J2 expense defaults to allowing negative',
     L.openAccount('Expenses:Refundable', 'expense').allow_negative, true);
  eq('J3 an explicit opt-in is honoured',
     L.openAccount('Assets:CreditLine', 'asset', { allowNegative: true }).allow_negative, true);

  rejects('J4 paying out of an empty cash account', 'WOULD_GO_NEGATIVE', () => L.post({
    idempotencyKey: 'neg-1', date: '2026-08-08', description: 'overspend',
    legs: [{ account: 'Expenses:Refundable', side: 'debit', amount: '50.00' },
           { account: 'Assets:Cash2', side: 'credit', amount: '50.00' }],
    expectedTotal: '50.00' }));

  L.post({ idempotencyKey: 'fund', date: '2026-08-08', description: 'funding',
    legs: [{ account: 'Assets:Cash2', side: 'debit', amount: '100.00' },
           { account: 'Income:Sales', side: 'credit', amount: '100.00' }],
    expectedTotal: '100.00' });
  eq('J5 once funded, the same payment goes through', L.post({
    idempotencyKey: 'neg-2', date: '2026-08-08', description: 'now affordable',
    legs: [{ account: 'Expenses:Refundable', side: 'debit', amount: '50.00' },
           { account: 'Assets:Cash2', side: 'credit', amount: '50.00' }],
    expectedTotal: '50.00' }).ok, true);

  eq('J6 an opted-in account may go below zero', L.post({
    idempotencyKey: 'neg-3', date: '2026-08-08', description: 'on the credit line',
    legs: [{ account: 'Expenses:Refundable', side: 'debit', amount: '75.00' },
           { account: 'Assets:CreditLine', side: 'credit', amount: '75.00' }],
    expectedTotal: '75.00' }).ok, true);
  eq('J7 and it really is negative', L.balance('Assets:CreditLine').balance, '-75.00');
  L.close();
}

console.log('\n\x1b[1mK. Import keys survive the file being reordered\x1b[0m');
{
  const L = freshBook();
  L.openAccount('Assets:Bank2', 'asset', { allowNegative: true });
  L.openAccount('Expenses:Misc2', 'expense');
  const TX = [
    '2026-08-01 Coffee\n    Expenses:Misc2    12.00 SGD\n    Assets:Bank2     -12.00 SGD\n',
    '2026-08-02 Lunch\n    Expenses:Misc2    30.00 SGD\n    Assets:Bank2     -30.00 SGD\n',
    '2026-08-01 Coffee\n    Expenses:Misc2    12.00 SGD\n    Assets:Bank2     -12.00 SGD\n',
  ];
  const j = (order) => order.map((i) => TX[i]).join('\n');

  const first = L.importJournal(j([0, 1, 2]), { source: 'bank.journal' });
  eq('K1 three transactions imported', first.imported, 3);
  eq('K2 including both identical coffees', L.info().entries, 3);

  // Same content, lines reordered. A key derived from the line number would
  // match nothing here and post everything a second time.
  const again = L.importJournal(j([2, 0, 1]), { source: 'bank.journal' });
  eq('K3 re-importing reordered content adds nothing', again.imported, 0);
  eq('K4 all three recognised as already present', again.already_present, 3);
  eq('K5 the book still holds three entries', L.info().entries, 3);
  L.close();
}


console.log('\n\x1b[1mI. Period locking\x1b[0m');
{
  const L = freshBook();
  L.post(ENTRY({ date: '2026-07-15' }));
  L.lock('2026-07-31');
  rejects('I1 cannot post into a locked period', 'PERIOD_LOCKED',
    () => L.post(ENTRY({ idempotencyKey: 'i1', date: '2026-07-20' })));
  const r = L.post(ENTRY({ idempotencyKey: 'i2', date: '2026-08-01' }));
  eq('I2 posting after the lock date works normally', r.ok, true);
  rejects('I3 lock date cannot move backward', 'LOCK_DATE_REGRESSION', () => L.lock('2026-06-30'));
  L.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
