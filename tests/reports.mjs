// Financial statements + hledger/ledger interop.
// Run: node tests/reports.mjs

import { balanceSheet, incomeStatement, ageing } from '../src/reports.ts';
import { toJournal, fromJournal, inferBlankAmount, InteropError } from '../src/interop.ts';
import { currencyOf, Money } from '../src/money.ts';

let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const has = (n, hay, needle) =>
  (String(hay).includes(needle) ? ok(n, `contains "${needle}"`) : bad(n, `missing "${needle}" in: ${String(hay).slice(0, 120)}`));
const rejects = (n, fn) => {
  try { fn(); bad(n, 'should have been rejected'); }
  catch (e) { ok(n, 'rejected: ' + e.message.slice(0, 70)); }
};

const USD = currencyOf('USD');

// A tiny but complete set of books:
//   assets 8000 = liabilities 3000 + equity 4000 + profit (2000 - 1000)
const ROWS = [
  { account: 'Assets:Bank:Checking', type: 'asset',     balance: 800000n },
  { account: 'Liabilities:Loan',     type: 'liability', balance: 300000n },
  { account: 'Equity:Capital',       type: 'equity',    balance: 400000n },
  { account: 'Income:Sales',         type: 'income',    balance: 200000n },
  { account: 'Expenses:Rent',        type: 'expense',   balance: 100000n },
];

console.log('\n\x1b[1mA. Balance sheet\x1b[0m');
{
  const bs = balanceSheet(ROWS, USD, '2026-08-08');
  eq('A1 the accounting identity holds', bs.ok, true);
  eq('A2 total assets', bs.assets.total, '8000.00');
  eq('A3 total liabilities', bs.liabilities.total, '3000.00');
  eq('A4 equity before profit', bs.equity.total, '4000.00');
  eq('A5 profit for the period is shown separately', bs.equity.retained_earnings_this_period, '1000.00');
  eq('A6 equity including profit', bs.equity.total_including_profit, '5000.00');
  eq('A7 assets = liabilities + equity + profit', bs.identity.difference, '0.00');
  eq('A8 zero-balance accounts are omitted',
     balanceSheet([...ROWS, { account: 'Assets:Unused', type: 'asset', balance: 0n }], USD)
       .assets.accounts.length, 1);
}

console.log('\n\x1b[1mB. A broken identity is reported, not hidden\x1b[0m');
{
  // Corrupt one balance the way a bypassed write would
  const broken = ROWS.map((r) => r.account === 'Assets:Bank:Checking' ? { ...r, balance: 799999n } : r);
  const bs = balanceSheet(broken, USD);
  eq('B1 identity fails', bs.ok, false);
  eq('B2 the gap is reported exactly', bs.identity.difference, '-0.01');
  has('B3 and it says this is not a rounding artifact', bs.problem, 'not a rounding artifact');
  has('B4 and points at the tool that locates it', bs.problem, 'postledger verify');
}

console.log('\n\x1b[1mC. Income statement\x1b[0m');
{
  const is = incomeStatement(ROWS, USD, { from: '2026-01-01', to: '2026-12-31' });
  eq('C1 income', is.income.total, '2000.00');
  eq('C2 expenses', is.expenses.total, '1000.00');
  eq('C3 net income', is.net_income, '1000.00');
  eq('C4 profitable', is.profitable, true);
  const loss = incomeStatement(
    [{ account: 'Income:Sales', type: 'income', balance: 100n },
     { account: 'Expenses:Rent', type: 'expense', balance: 500n }], USD);
  eq('C5 a loss is reported as negative', loss.net_income, '-4.00');
  eq('C6 and not marked profitable', loss.profitable, false);
}

console.log('\n\x1b[1mD. Ageing buckets\x1b[0m');
{
  const a = ageing([
    { ref: 'INV-1', date: '2026-08-08', amount: 10000n, counterparty: 'Acme' },   // 0 days
    { ref: 'INV-2', date: '2026-07-20', amount: 20000n, counterparty: 'Beta' },   // 19 days
    { ref: 'INV-3', date: '2026-06-20', amount: 30000n, counterparty: 'Gamma' },  // 49 days
    { ref: 'INV-4', date: '2026-01-01', amount: 40000n, counterparty: 'Delta' },  // 219 days
  ], USD, '2026-08-08');
  const by = Object.fromEntries(a.buckets.map((b) => [b.bucket, b]));
  eq('D1 same-day item is current', by.current.count, 1);
  eq('D2 19 days → 1-30 bucket', by['1-30'].count, 1);
  eq('D3 49 days → 31-60 bucket', by['31-60'].count, 1);
  eq('D4 219 days → 90+ bucket', by['90+'].count, 1);
  eq('D5 grand total', a.total, '1000.00');
  eq('D6 oldest bucket carries the counterparty', by['90+'].items[0].counterparty, 'Delta');
}

console.log('\n\x1b[1mE. Export to hledger/ledger journal\x1b[0m');
{
  const entries = [{
    date: '2026-08-08', description: 'Invoice 001',
    entry_id: 'e_abc123', idempotency_key: 'inv-001', actor: 'agent:test',
    legs: [
      { account: 'Assets:Bank:Checking', side: 'debit',  amount: 500000n },
      { account: 'Income:Sales',         side: 'credit', amount: 500000n },
    ],
  }];
  const j = toJournal(entries, USD, { bookName: 'Acme Co' });
  has('E1 has a date + description header', j, '2026-08-08 Invoice 001');
  has('E2 debit is positive',  j, '5000.00 USD');
  has('E3 credit is negative', j, '-5000.00 USD');
  has('E4 sign convention is documented in the header', j, 'positive = debit');
  has('E5 entry id survives as a tag',  j, 'entry:e_abc123');
  has('E6 idempotency key survives',    j, 'idem:inv-001');
  has('E7 actor survives',              j, 'actor:agent:test');
}

console.log('\n\x1b[1mF. Import from a journal\x1b[0m');
{
  const src = `
; a normal hledger file
2026-08-08 Invoice 001
    Assets:Bank:Checking     5000.00 USD
    Income:Sales            -5000.00 USD

2026-08-09 * Office rent
    Expenses:Rent            1200.00 USD
    Assets:Bank:Checking    -1200.00 USD
`;
  const parsed = fromJournal(src, USD);
  eq('F1 two transactions parsed', parsed.length, 2);
  eq('F2 date',        parsed[0].date, '2026-08-08');
  eq('F3 description', parsed[0].description, 'Invoice 001');
  eq('F4 positive amount → debit',  parsed[0].legs[0].side, 'debit');
  eq('F5 negative amount → credit', parsed[0].legs[1].side, 'credit');
  eq('F6 credit stored as a positive magnitude', parsed[0].legs[1].amount, '5000.00');
  eq('F7 expectedTotal is the debit side', parsed[0].expectedTotal, '5000.00');
  eq('F8 the * status flag is stripped from the description', parsed[1].description, 'Office rent');
}

console.log('\n\x1b[1mG. Round-trip is lossless\x1b[0m');
{
  const original = [{
    date: '2026-08-08', description: 'Split payout',
    legs: [
      { account: 'Assets:Bank:Checking', side: 'debit',  amount: 482015n },
      { account: 'Expenses:Fees',        side: 'debit',  amount: 17985n  },
      { account: 'Income:Sales',         side: 'credit', amount: 500000n },
    ],
  }];
  const back = fromJournal(toJournal(original, USD, { includeTags: false }), USD);
  eq('G1 one transaction survives', back.length, 1);
  eq('G2 three legs survive', back[0].legs.length, 3);
  eq('G3 leg 1 amount', back[0].legs[0].amount, '4820.15');
  eq('G4 leg 2 amount', back[0].legs[1].amount, '179.85');
  eq('G5 leg 3 is the credit side', back[0].legs[2].side, 'credit');
  eq('G6 total preserved to the cent', back[0].expectedTotal, '5000.00');

  // Regression: exporting WITH tags used to break re-import. The tag comment
  // line, once its comment was stripped, looked like a blank line and closed
  // the transaction early — so the entry came back with zero postings.
  const tagged = [{
    date: '2026-08-08', description: 'Owner capital',
    entry_id: 'e_abc', idempotency_key: 'cap', actor: 'agent:x',
    legs: [
      { account: 'Assets:Bank:Checking', side: 'debit',  amount: 400000n },
      { account: 'Equity:Capital',       side: 'credit', amount: 400000n },
    ],
  }];
  const rt = fromJournal(toJournal(tagged, USD), USD);   // tags ON — the path that broke
  eq('G7 tagged export re-imports as one transaction', rt.length, 1);
  eq('G8 with both legs intact', rt[0].legs.length, 2);
  eq('G9 and the entry id is recovered from the tag', rt[0].tags.entry, 'e_abc');
  eq('G10 and the idempotency key too', rt[0].tags.idem, 'cap');
}

console.log('\n\x1b[1mH. Bad input is refused, never half-imported\x1b[0m');
{
  rejects('H1 unbalanced transaction', () => fromJournal(
    `2026-08-08 Bad\n    A:X   100.00 USD\n    B:Y   -99.00 USD\n`, USD));
  rejects('H2 a different currency', () => fromJournal(
    `2026-08-08 Bad\n    A:X   100.00 EUR\n    B:Y   -100.00 EUR\n`, USD));
  rejects('H3 thousands separators', () => fromJournal(
    `2026-08-08 Bad\n    A:X   1,000.00 USD\n    B:Y   -1,000.00 USD\n`, USD));
  rejects('H4 only one posting', () => fromJournal(
    `2026-08-08 Lonely\n    A:X   100.00 USD\n`, USD));
  rejects('H5 automated transaction rules', () => fromJournal(
    `= expenses:food\n    budget:food  -1.00 USD\n`, USD));
  rejects('H6 two blank amounts (ambiguous)', () => fromJournal(
    `2026-08-08 Ambiguous\n    A:X   100.00 USD\n    B:Y\n    C:Z\n`, USD));
}

console.log('\n\x1b[1mI. Blank amount is inferred the way ledger does\x1b[0m');
{
  const legs = [{ account: 'Expenses:Rent', side: 'debit', amount: '1200.00' }];
  const filled = inferBlankAmount(legs, 'Assets:Bank:Checking', USD);
  eq('I1 the inferred side balances the entry', filled.side, 'credit');
  eq('I2 the inferred amount', filled.amount, '1200.00');
  rejects('I3 refuses when the entry already balances', () => inferBlankAmount(
    [{ account: 'A:X', side: 'debit', amount: '10.00' },
     { account: 'B:Y', side: 'credit', amount: '10.00' }], 'C:Z', USD));
}

console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
