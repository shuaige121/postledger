/**
 * Financial statements, as pure functions over account balances.
 *
 * These take rows and return numbers. They touch no database and hold no state,
 * which is the point: a report you cannot reproduce from the journal is a report
 * nobody should trust. `verify` recomputes the same balances from postings and
 * asserts they agree.
 *
 * The accounting identity is treated as an assertion, not a hope:
 *
 *     Assets = Liabilities + Equity + (Income - Expenses)
 *
 * The parenthesised term is profit that has not been closed into equity yet.
 * If this does not hold exactly, the books are broken and the report says so
 * rather than quietly printing a plausible-looking page.
 */

import { Money, type Currency } from './money.ts';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface BalanceRow {
  account: string;
  type: AccountType;
  /** Signed normal balance in minor units */
  balance: bigint;
}

export interface Section {
  title: string;
  accounts: Array<{ account: string; balance: string }>;
  total: string;
}

const sum = (rows: BalanceRow[]) => rows.reduce((s, r) => s + r.balance, 0n);

function section(title: string, rows: BalanceRow[], currency: Currency): Section {
  const picked = rows.filter((r) => r.balance !== 0n).sort((a, b) => a.account.localeCompare(b.account));
  return {
    title,
    accounts: picked.map((r) => ({
      account: r.account,
      balance: Money.ofMinor(r.balance, currency).format(),
    })),
    total: Money.ofMinor(sum(rows), currency).format(),
  };
}

/**
 * Balance sheet: what the entity owns, owes, and is worth, at a point in time.
 *
 * Profit for the period is shown as a separate line inside equity rather than
 * being folded into it silently — otherwise a reader cannot tell retained
 * earnings apart from this period's result without going back to the journal.
 */
export function balanceSheet(rows: BalanceRow[], currency: Currency, asOf?: string) {
  const assets = rows.filter((r) => r.type === 'asset');
  const liabilities = rows.filter((r) => r.type === 'liability');
  const equity = rows.filter((r) => r.type === 'equity');
  const income = rows.filter((r) => r.type === 'income');
  const expenses = rows.filter((r) => r.type === 'expense');

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity);
  const netIncome = sum(income) - sum(expenses);

  // Assets − (Liabilities + Equity + unclosed profit). Must be exactly zero.
  const drift = totalAssets - (totalLiabilities + totalEquity + netIncome);

  return {
    ok: drift === 0n,
    as_of: asOf ?? null,
    currency: currency.code,
    assets: section('Assets', assets, currency),
    liabilities: section('Liabilities', liabilities, currency),
    equity: {
      ...section('Equity', equity, currency),
      retained_earnings_this_period: Money.ofMinor(netIncome, currency).format(),
      total_including_profit: Money.ofMinor(totalEquity + netIncome, currency).format(),
    },
    identity: {
      assets: Money.ofMinor(totalAssets, currency).format(),
      liabilities_plus_equity: Money.ofMinor(totalLiabilities + totalEquity + netIncome, currency).format(),
      difference: Money.ofMinor(drift, currency).format(),
      holds: drift === 0n,
    },
    ...(drift === 0n
      ? {}
      : {
          problem:
            'The accounting identity does not hold. This is not a rounding artifact — ' +
            'money here is integer minor units. Run `postledger verify` to locate the damage.',
        }),
  };
}

/**
 * Income statement (profit and loss) for a period.
 *
 * Note the caller must pass balances already restricted to the period; this
 * function does not know about dates. Keeping the filtering outside means the
 * same function serves "this month", "since inception", and "one project".
 */
export function incomeStatement(
  rows: BalanceRow[],
  currency: Currency,
  period?: { from?: string; to?: string },
) {
  const income = rows.filter((r) => r.type === 'income');
  const expenses = rows.filter((r) => r.type === 'expense');
  const totalIncome = sum(income);
  const totalExpenses = sum(expenses);
  const net = totalIncome - totalExpenses;

  return {
    ok: true as const,
    period: { from: period?.from ?? null, to: period?.to ?? null },
    currency: currency.code,
    income: section('Income', income, currency),
    expenses: section('Expenses', expenses, currency),
    net_income: Money.ofMinor(net, currency).format(),
    profitable: net > 0n,
  };
}

/**
 * Ageing buckets for a set of dated open items.
 *
 * Deliberately generic: it takes {date, amount} pairs and a reference date, so
 * it works for receivables, payables, or anything else with an age. The buckets
 * are the ones every accountant expects to see.
 */
export function ageing(
  items: Array<{ ref: string; date: string; amount: bigint; counterparty?: string }>,
  currency: Currency,
  asOf: string,
) {
  const BUCKETS = [
    { label: 'current', min: -Infinity, max: 0 },
    { label: '1-30', min: 1, max: 30 },
    { label: '31-60', min: 31, max: 60 },
    { label: '61-90', min: 61, max: 90 },
    { label: '90+', min: 91, max: Infinity },
  ];
  const asOfMs = Date.parse(asOf + 'T00:00:00Z');

  const buckets = BUCKETS.map((b) => ({ ...b, items: [] as typeof items, total: 0n }));
  for (const it of items) {
    const days = Math.floor((asOfMs - Date.parse(it.date + 'T00:00:00Z')) / 86_400_000);
    const bucket = buckets.find((b) => days >= b.min && days <= b.max) ?? buckets[buckets.length - 1]!;
    bucket.items.push(it);
    bucket.total += it.amount;
  }

  return {
    ok: true as const,
    as_of: asOf,
    currency: currency.code,
    buckets: buckets.map((b) => ({
      bucket: b.label,
      count: b.items.length,
      total: Money.ofMinor(b.total, currency).format(),
      items: b.items.map((i) => ({
        ref: i.ref,
        date: i.date,
        counterparty: i.counterparty ?? null,
        amount: Money.ofMinor(i.amount, currency).format(),
      })),
    })),
    total: Money.ofMinor(items.reduce((s, i) => s + i.amount, 0n), currency).format(),
  };
}
