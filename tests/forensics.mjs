// Forensics & correction tests: bulk revert by actor, accounting error-diagnosis
// tricks, anchor cross-checking, gap detection, statistical signals
// Run: node tests/forensics.mjs

import { Ledger, PostledgerError } from '../src/ledger.ts';
import { benford } from '../src/audit.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const has = (n, hay, needle) =>
  (String(hay).includes(needle) ? ok(n, `contains "${needle}"`) : bad(n, `didn't find "${needle}", got: ${hay}`));

const dir = mkdtempSync(join(tmpdir(), 'postledger-forensics-'));
const bookPath = join(dir, 'book.db');

function freshBook() {
  for (const s of ['', '-wal', '-shm']) rmSync(bookPath + s, { force: true });
  const L = Ledger.create(bookPath, { name: 'Forensics Co', currency: 'SGD' });
  // These suites exercise statistical signals, not the overdraft guard, and
  // they post payments out of accounts they never fund. Opting into a negative
  // balance keeps the fixture focused instead of padding every case with a
  // funding entry.
  L.openAccount('Assets:Bank', 'asset', { allowNegative: true });
  L.openAccount('Assets:Cash', 'asset', { allowNegative: true });
  L.openAccount('Income:Sales', 'income');
  L.openAccount('Expenses:Misc', 'expense');
  return L;
}
const simple = (over = {}) => ({
  idempotencyKey: 'k', date: '2026-08-08', description: 'x',
  legs: [{ account: 'Assets:Bank', side: 'debit', amount: '100.00' },
         { account: 'Income:Sales', side: 'credit', amount: '100.00' }],
  expectedTotal: '100.00', ...over,
});

console.log('\n\x1b[1mA. Revert everything a given actor posted\x1b[0m');
{
  const L = freshBook();
  // a normal human posts 2 entries
  L.post(simple({ idempotencyKey: 'h1', description: 'Normal entry 1', actor: 'human:alice' }));
  L.post(simple({ idempotencyKey: 'h2', description: 'Normal entry 2', actor: 'human:alice' }));
  // a rogue agent posts 3 entries
  for (let i = 1; i <= 3; i++) {
    L.post(simple({ idempotencyKey: `bot${i}`, description: `Bogus entry ${i}`, actor: 'agent:rogue',
      legs: [{ account: 'Assets:Bank', side: 'debit', amount: '999.00' },
             { account: 'Income:Sales', side: 'credit', amount: '999.00' }],
      expectedTotal: '999.00' }));
  }
  eq('A1 bank account is polluted', L.balance('Assets:Bank').balance, '3197.00');
  eq('A2 can list all actors', L.actors().actors.length, 2);
  eq('A3 can find how many entries this agent posted', L.entriesByActor('agent:rogue').count, 3);

  // dry-run first to see what would be reverted
  const dry = L.revertActor('agent:rogue', { idempotencyKey: 'x', reason: 'agent went rogue', dryRun: true });
  eq('A4 dry-run does not change the book', L.balance('Assets:Bank').balance, '3197.00');
  eq('A5 dry-run reports 3 entries would be reverted', dry.matched, 3);
  const impact = dry.balance_impact.find((b) => b.account === 'Assets:Bank');
  eq('A6 dry-run previews the post-revert balance', impact.after, '200.00');

  // actually revert
  const done = L.revertActor('agent:rogue', { idempotencyKey: 'revert-rogue-1', reason: 'agent went rogue' });
  eq('A7 reverted 3 entries', done.reverted, 3);
  eq('A8 bank account back to a clean state', L.balance('Assets:Bank').balance, '200.00');
  eq("A9 the normal human's entries untouched", L.entriesByActor('human:alice').count, 2);
  eq('A10 books still balance', L.trialBalance().balanced, true);

  // the key point: this is reversal, not deletion — history stays fully intact
  eq('A11 all 5 original entries still there (history is evidence)',
     L.entries({ limit: 100 }).entries.filter((e) => !e.description.startsWith('REVERSAL')).length, 5);
  eq('A12 8 entries total counting reversals', L.info().entries, 8);
  eq('A13 audit chain intact', L.verify({ documents: false }).ok, true);

  // idempotent: rerunning does not revert twice
  const again = L.revertActor('agent:rogue', { idempotencyKey: 'revert-rogue-1', reason: 'agent went rogue' });
  eq('A14 rerunning the same batch key → reports 3 already reverted', again.already_done, 3);
  has('A14b and states plainly that the books are unchanged', again.note, 'books are unchanged');
  eq('A15 and produces no new entries', L.info().entries, 8);
  eq('A16 balance unchanged', L.balance('Assets:Bank').balance, '200.00');
  L.close();
}

console.log("\n\x1b[1mB. Accounting error-diagnosis tricks (when debits and credits don't balance)\x1b[0m");
{
  const L = freshBook();

  // the divisible-by-9 rule: 54.00 typed as 45.00, the 9.00 difference is divisible by 9
  try {
    L.post(simple({ idempotencyKey: 'b1',
      legs: [{ account: 'Assets:Bank', side: 'debit', amount: '54.00' },
             { account: 'Income:Sales', side: 'credit', amount: '45.00' }],
      expectedTotal: '54.00' }));
    bad('B1 transposition error is diagnosed', 'no error was thrown');
  } catch (e) {
    has('B1 transposition error → hints at the divisible-by-9 rule', e.detail.likely_causes.join(' | '), 'divisible by 9');
    has('B1b and explains it is digit transposition', e.detail.likely_causes.join(' | '), 'transposition');
  }

  // the divisible-by-2 rule: a $100 leg posted on the wrong side, the two sides differ by 200
  try {
    L.post(simple({ idempotencyKey: 'b2',
      legs: [{ account: 'Assets:Bank', side: 'debit', amount: '300.00' },
             { account: 'Assets:Cash', side: 'debit', amount: '100.00' },
             { account: 'Income:Sales', side: 'credit', amount: '200.00' }],
      expectedTotal: '400.00' }));
    bad('B2 wrong-direction error is diagnosed', 'no error was thrown');
  } catch (e) {
    has('B2 wrong direction → points to which leg', e.detail.likely_causes.join(' | '), 'wrong side');
    has('B2b and names the specific account', e.detail.likely_causes.join(' | '), 'Assets:Cash');
  }

  // missing counterpart leg: the difference exactly equals one of the legs
  try {
    L.post(simple({ idempotencyKey: 'b3',
      legs: [{ account: 'Assets:Bank', side: 'debit', amount: '100.00' },
             { account: 'Assets:Cash', side: 'debit', amount: '70.00' },
             { account: 'Income:Sales', side: 'credit', amount: '100.00' }],
      expectedTotal: '170.00' }));
    bad('B3 missing leg is diagnosed', 'no error was thrown');
  } catch (e) {
    has('B3 missing leg → points out the difference exactly equals one leg', e.detail.likely_causes.join(' | '), 'counterpart leg is probably missing');
  }
  L.close();
}

console.log("\n\x1b[1mC. Anchor cross-checking (defends against local root recomputing the whole chain)\x1b[0m");
{
  const L = freshBook();
  const anchors = join(dir, 'anchors.log');

  L.post(simple({ idempotencyKey: 'c1', description: 'First entry' }));
  appendFileSync(anchors, L.anchor().line + '\n');
  L.post(simple({ idempotencyKey: 'c2', description: 'Second entry' }));
  appendFileSync(anchors, L.anchor().line + '\n');
  L.post(simple({ idempotencyKey: 'c3', description: 'Third entry' }));
  appendFileSync(anchors, L.anchor().line + '\n');

  const v = L.verifyAgainstAnchors(anchors);
  eq('C1 anchors all match when nothing has been tampered with', v.ok, true);
  eq('C2 checked 3 witness points', v.anchors_checked, 3);
  L.close();

  // attacker with root: deletes the last entry, wipes chain_head along with
  // it, and recomputes the whole chain to stay self-consistent
  const raw = new DatabaseSync(bookPath);
  raw.exec('DROP TRIGGER entry_no_delete; DROP TRIGGER posting_no_delete; DROP TRIGGER chain_head_no_delete');
  raw.exec("DELETE FROM postings WHERE entry_id IN (SELECT id FROM entries WHERE seq=3)");
  raw.exec('DELETE FROM entries WHERE seq=3');
  raw.exec('DELETE FROM chain_head WHERE seq=3');       // erase the trace too
  raw.close();

  const L2 = Ledger.open(bookPath);
  const inner = L2.verify({ documents: false });
  eq("C3 self-certifying locally: clean up thoroughly enough and it can't be detected", inner.ok, true);
  ok('C4 ↑ this is exactly the proof that "a self-signed hash can\'t stop whoever holds the keys"');

  const outer = L2.verifyAgainstAnchors(anchors);
  eq('C5 but an external anchor sees through it instantly', outer.ok, false);
  has('C6 and points out entry 3 is gone', JSON.stringify(outer.problems), 'seq 3 is gone');
  L2.close();
}

console.log('\n\x1b[1mD. Gap detection (deleted from the middle)\x1b[0m');
{
  const L = freshBook();
  for (let i = 1; i <= 4; i++) L.post(simple({ idempotencyKey: `d${i}`, description: `Entry ${i}` }));
  L.close();

  const raw = new DatabaseSync(bookPath);
  raw.exec('DROP TRIGGER entry_no_delete; DROP TRIGGER posting_no_delete');
  raw.exec("DELETE FROM postings WHERE entry_id IN (SELECT id FROM entries WHERE seq=2)");
  raw.exec('DELETE FROM entries WHERE seq=2');   // delete only the entry, leave chain_head alone
  raw.close();

  const L2 = Ledger.open(bookPath);
  const v = L2.verify({ documents: false });
  eq('D1 deleted from the middle → verification fails', v.ok, false);
  has('D2 and clearly points out #2 is missing', JSON.stringify(v.problems), 'deleted from the middle');
  L2.close();
}

console.log('\n\x1b[1mE. Benford test\x1b[0m');
{
  // generate a batch of Benford-conforming data (using a 10^U distribution,
  // the classic construction for which Benford's law holds)
  const conforming = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 600; i++) conforming.push(BigInt(Math.floor(10 ** (rnd() * 4 + 2))));
  const b1 = benford(conforming);
  eq('E1 natural distribution → sample is large enough', b1.applicable, true);
  ok('E2 MAD verdict for the natural distribution', `${b1.mad_verdict} (MAD=${b1.mad})`);
  eq('E3 natural distribution does not trigger the chi-square alert', b1.chi_square_exceeds_p05, false);

  // generate a batch of "made-up" data: both humans and LLMs favor a uniform
  // distribution of leading digits
  const fabricated = [];
  for (let i = 0; i < 600; i++) fabricated.push(BigInt(Math.floor(rnd() * 9 + 1) * 1000 + Math.floor(rnd() * 100)));
  const b2 = benford(fabricated);
  eq('E4 fabricated data → judged nonconforming', b2.mad_verdict, 'nonconforming');
  eq('E5 and chi-square exceeds the critical value', b2.chi_square_exceeds_p05, true);
  has('E6 the wording is "worth a look", not "this is fraud"', b2.note, 'REASON TO LOOK');

  // must refuse to conclude anything when the sample is too small
  const b3 = benford([1n, 2n, 3n, 40n, 500n]);
  eq('E7 small sample → not applicable', b3.applicable, false);
  has('E8 and explains why', b3.note, 'too small');
}

console.log('\n\x1b[1mF. Statistical signal overview\x1b[0m');
{
  const L = freshBook();
  // all round numbers + lots of repeated amounts — the classic signature of a "made-up" book
  for (let i = 1; i <= 25; i++) {
    L.post(simple({ idempotencyKey: `f${i}`, description: `Payment ${i}`,
      legs: [{ account: 'Expenses:Misc', side: 'debit', amount: '5000.00' },
             { account: 'Assets:Bank', side: 'credit', amount: '5000.00' }],
      expectedTotal: '5000.00' }));
  }
  const a = L.auditSignals();
  eq('F1 sampled 25 entries', a.sample.entries, 25);
  eq('F2 round-number ratio is flagged', a.signals.find((s) => s.signal === 'round_numbers').severity, 'look');
  eq('F3 duplicate amounts are flagged', a.signals.find((s) => s.signal === 'duplicate_amounts').severity, 'look');
  has('F4 disclaimer is present in the result', a.disclaimer, 'INDICATOR, not evidence');
  eq('F5 Benford declines to conclude due to small sample', a.benford.applicable, false);
  L.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
