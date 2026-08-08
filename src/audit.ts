/**
 * Statistical forensics — surfacing what's "worth a look."
 *
 * One caveat up front, and every conclusion in this module is bound by it:
 *
 *   Everything here is an **indicator, not evidence**.
 *   A deviation is not fraud, and conformity is not innocence. Their job is to
 *   point an auditor's (or your own) attention at specific entries — after
 *   that, a human still has to go look at the source document.
 *   Treating any of this as "the system decided these books are fake" is a
 *   misuse.
 *
 * Why this belongs in an AI bookkeeping tool specifically:
 * Fabricated numbers leave fingerprints. Numbers made up by a human and
 * numbers made up by an LLM both deviate from the natural distribution —
 * they favor middle digits, round numbers, and amounts that land just under
 * an approval threshold. Real books don't.
 */

/** Theoretical frequency of Benford's leading digit: P(d) = log10(1 + 1/d) */
const BENFORD_FIRST = [
  0.30103, 0.17609, 0.12494, 0.09691, 0.07918, 0.06695, 0.05799, 0.05115, 0.04576,
];

export interface BenfordResult {
  applicable: boolean;
  sample_size: number;
  digits: Array<{ digit: number; observed: number; expected: number; observed_pct: string; expected_pct: string }>;
  /** Nigrini's MAD criterion */
  mad: number;
  mad_verdict: 'close' | 'acceptable' | 'marginal' | 'nonconforming' | 'n/a';
  chi_square: number;
  /** Critical value for p=0.05 at df=8 is 15.507 */
  chi_square_exceeds_p05: boolean;
  note: string;
}

/** Leading significant digit of an integer minor-units amount */
function firstDigit(minor: bigint): number {
  const s = (minor < 0n ? -minor : minor).toString().replace(/^0+/, '');
  return s.length ? Number(s[0]) : 0;
}

export function benford(amountsMinor: bigint[]): BenfordResult {
  const digits = amountsMinor.map(firstDigit).filter((d) => d >= 1 && d <= 9);
  const n = digits.length;

  const counts = new Array(9).fill(0);
  for (const d of digits) counts[d - 1]++;

  const rows = counts.map((observed, i) => ({
    digit: i + 1,
    observed,
    expected: n * BENFORD_FIRST[i]!,
    observed_pct: n ? ((observed / n) * 100).toFixed(1) + '%' : '—',
    expected_pct: (BENFORD_FIRST[i]! * 100).toFixed(1) + '%',
  }));

  // Benford is meaningless on a small sample. Nigrini recommends at least a
  // few hundred entries; below 100, random noise alone can produce any
  // "deviation" you like.
  if (n < 100) {
    return {
      applicable: false, sample_size: n, digits: rows,
      mad: 0, mad_verdict: 'n/a', chi_square: 0, chi_square_exceeds_p05: false,
      note: `Sample of ${n} is too small for Benford analysis (need 100+, ideally 1000+). ` +
            `Any "deviation" at this size is noise. Reported for reference only.`,
    };
  }

  const mad = rows.reduce((s, r) => s + Math.abs(r.observed / n - BENFORD_FIRST[r.digit - 1]!), 0) / 9;
  const chi = rows.reduce((s, r) => s + (r.observed - r.expected) ** 2 / r.expected, 0);

  // Nigrini (2012) leading-digit MAD criterion
  const verdict: BenfordResult['mad_verdict'] =
    mad < 0.006 ? 'close' : mad < 0.012 ? 'acceptable' : mad < 0.015 ? 'marginal' : 'nonconforming';

  return {
    applicable: true, sample_size: n, digits: rows,
    mad: Number(mad.toFixed(5)), mad_verdict: verdict,
    chi_square: Number(chi.toFixed(3)), chi_square_exceeds_p05: chi > 15.507,
    note: verdict === 'nonconforming' || chi > 15.507
      ? 'Deviates from the expected distribution. This is a REASON TO LOOK, not a finding. ' +
        'Legitimate causes are common: assigned prices, a small number of repeated contract values, ' +
        'amounts with a natural floor or cap.'
      : 'Consistent with the expected distribution. This does NOT mean the books are clean — ' +
        'a careful fabricator can match Benford deliberately.',
  };
}

export interface AuditSignal {
  signal: string;
  severity: 'info' | 'look';
  finding: string;
  detail?: unknown;
}

/**
 * Proportion of round amounts.
 * Real transactions do produce whole numbers like 1000.00 or 5000.00 (rent,
 * a lump-sum transfer), but a high proportion usually means the figures were
 * "thought up" rather than "computed."
 */
export function roundNumbers(amountsMinor: bigint[], decimals: number): AuditSignal {
  const scale = 10n ** BigInt(decimals);
  const n = amountsMinor.length;
  if (n === 0) return { signal: 'round_numbers', severity: 'info', finding: 'no data' };

  const wholeUnits = amountsMinor.filter((a) => a % scale === 0n).length;
  const round100 = amountsMinor.filter((a) => a % (scale * 100n) === 0n).length;
  const pct = (wholeUnits / n) * 100;

  return {
    signal: 'round_numbers',
    // In real data, whole-unit amounts are usually well under 50%
    severity: pct > 60 ? 'look' : 'info',
    finding: `${pct.toFixed(1)}% of amounts are whole units (${wholeUnits}/${n}); ` +
             `${((round100 / n) * 100).toFixed(1)}% are multiples of 100`,
    detail: { whole_unit_pct: Number(pct.toFixed(1)), multiples_of_100: round100, sample: n },
  };
}

/**
 * Duplicate amounts.
 * The same amount recurring can be entirely normal (monthly rent, a fixed
 * sale price), or it can be copy-pasted fake entries. What matters is
 * whether the concentration is abnormal.
 */
export function duplicateAmounts(
  entries: Array<{ id: string; total: bigint; date: string; description: string }>,
): AuditSignal {
  const byAmount = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = e.total.toString();
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k)!.push(e);
  }
  const repeated = [...byAmount.entries()]
    .filter(([, list]) => list.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  const topCount = repeated[0]?.[1].length ?? 0;
  return {
    signal: 'duplicate_amounts',
    severity: entries.length >= 20 && topCount > entries.length * 0.25 ? 'look' : 'info',
    finding: repeated.length
      ? `${repeated.length} amount(s) appear 3+ times; the most frequent appears ${topCount} times`
      : 'no amount repeats 3 or more times',
    detail: repeated.map(([amount, list]) => ({
      amount_minor: amount, occurrences: list.length,
      entries: list.slice(0, 5).map((e) => ({ id: e.id, date: e.date, description: e.description })),
    })),
  };
}

/**
 * Threshold avoidance (just-below-threshold).
 * A classic fraud pattern: the approval limit is 5000, so a cluster of
 * 4900, 4950, 4999 shows up. Each entry looks compliant on its own —
 * it's the distribution that gives it away.
 */
export function thresholdClustering(amountsMinor: bigint[], decimals: number, thresholds: number[]): AuditSignal {
  const scale = 10n ** BigInt(decimals);
  const hits: Array<{ threshold: number; just_below: number; just_above: number; ratio: string }> = [];

  for (const t of thresholds) {
    const T = BigInt(t) * scale;
    const band = T / 10n;                                  // 10%-wide band just below the threshold
    const below = amountsMinor.filter((a) => a >= T - band && a < T).length;
    const above = amountsMinor.filter((a) => a >= T && a < T + band).length;
    if (below + above >= 5 && below > above * 2) {
      hits.push({ threshold: t, just_below: below, just_above: above,
                  ratio: `${below}:${above}` });
    }
  }

  return {
    signal: 'threshold_clustering',
    severity: hits.length ? 'look' : 'info',
    finding: hits.length
      ? `amounts cluster just below ${hits.length} threshold(s) — a classic approval-limit avoidance pattern`
      : 'no clustering just below the given thresholds',
    detail: hits,
  };
}

/** Outlier amounts (median + MAD, more outlier-resistant than mean + stddev) */
export function outliers(
  entries: Array<{ id: string; total: bigint; date: string; description: string }>,
): AuditSignal {
  const n = entries.length;
  if (n < 10) return { signal: 'outliers', severity: 'info', finding: `sample of ${n} too small` };

  const sorted = [...entries].sort((a, b) => (a.total < b.total ? -1 : a.total > b.total ? 1 : 0));
  const median = Number(sorted[Math.floor(n / 2)]!.total);
  const devs = sorted.map((e) => Math.abs(Number(e.total) - median)).sort((a, b) => a - b);
  const mad = devs[Math.floor(n / 2)]! || 1;

  // Modified Z-score (Iglewicz & Hoaglin); |score| > 3.5 is conventionally treated as an outlier
  const flagged = entries
    .map((e) => ({ e, z: (0.6745 * (Number(e.total) - median)) / mad }))
    .filter((x) => Math.abs(x.z) > 3.5)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 10);

  return {
    signal: 'outliers',
    severity: flagged.length ? 'look' : 'info',
    finding: flagged.length
      ? `${flagged.length} entr${flagged.length === 1 ? 'y' : 'ies'} far from the median amount`
      : 'no extreme outliers',
    detail: flagged.map((x) => ({
      entry_id: x.e.id, date: x.e.date, description: x.e.description,
      amount_minor: x.e.total.toString(), modified_z: Number(x.z.toFixed(1)),
    })),
  };
}

/**
 * Posting-time pattern.
 * Late-night or weekend posting doesn't by itself mean anything is wrong,
 * but if one actor's writes cluster heavily in hours nobody reviews,
 * that's worth asking about.
 */
export function timingPattern(
  entries: Array<{ id: string; createdAt: string; actor: string | null }>,
): AuditSignal {
  if (entries.length < 20) {
    return { signal: 'timing', severity: 'info', finding: `sample of ${entries.length} too small` };
  }
  let offHours = 0, weekend = 0;
  for (const e of entries) {
    const d = new Date(e.createdAt);
    const h = d.getUTCHours();
    if (h < 6 || h >= 22) offHours++;
    const day = d.getUTCDay();
    if (day === 0 || day === 6) weekend++;
  }
  const pct = (offHours / entries.length) * 100;
  return {
    signal: 'timing',
    severity: pct > 50 ? 'look' : 'info',
    finding: `${pct.toFixed(0)}% posted outside 06:00–22:00 UTC, ` +
             `${((weekend / entries.length) * 100).toFixed(0)}% on weekends`,
    detail: { off_hours: offHours, weekend, total: entries.length,
              caveat: 'Automated posting and non-UTC timezones both produce this pattern legitimately.' },
  };
}
