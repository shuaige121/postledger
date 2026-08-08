/**
 * Money — an integer minor-unit amount, carried in a bigint.
 *
 * Floats are turned away right at the border: **there is no fromNumber()**.
 * There are exactly two ways in: a decimal string ("125.50") or an exact
 * minor-unit integer (12550n).
 *
 * This isn't fastidiousness for its own sake. A real-world case: a ledger
 * stored amounts as REAL, patched over it with round(x, 2), and decided
 * "settled" with `abs(paid - total) <= 0.01`. The result was that a
 * customer underpaid by a single cent, the invoice auto-flagged as settled
 * and moved into a terminal state, and every subsequent attempt to record
 * the shortfall was rejected — the only way out was voiding it and
 * reissuing. A ledger that can drift isn't a ledger.
 */

export interface Currency {
  /** ISO 4217 code, e.g. SGD */
  readonly code: string;
  /** Decimal places: 2 for SGD/USD, 0 for JPY, 3 for BHD */
  readonly decimals: number;
}

export class InvalidAmountError extends Error {
  readonly code = 'INVALID_AMOUNT';
}
export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
}

/** Common currencies. Anything not in this table can be constructed as {code, decimals}. */
export const CURRENCIES: Record<string, Currency> = {
  SGD: { code: 'SGD', decimals: 2 },
  USD: { code: 'USD', decimals: 2 },
  EUR: { code: 'EUR', decimals: 2 },
  GBP: { code: 'GBP', decimals: 2 },
  CNY: { code: 'CNY', decimals: 2 },
  HKD: { code: 'HKD', decimals: 2 },
  MYR: { code: 'MYR', decimals: 2 },
  JPY: { code: 'JPY', decimals: 0 },
  KRW: { code: 'KRW', decimals: 0 },
  BHD: { code: 'BHD', decimals: 3 },
  KWD: { code: 'KWD', decimals: 3 },
};

export function currencyOf(code: string): Currency {
  const c = CURRENCIES[code.toUpperCase()];
  if (!c) {
    throw new InvalidAmountError(
      `unknown currency ${JSON.stringify(code)}; ` +
        `known: ${Object.keys(CURRENCIES).join(', ')}`,
    );
  }
  return c;
}

export class Money {
  readonly minor: bigint;
  readonly currency: Currency;

  private constructor(minor: bigint, currency: Currency) {
    this.minor = minor;
    this.currency = currency;
    Object.freeze(this);
  }

  /** Construct exactly from minor units: ofMinor(12550n, SGD) === S$125.50 */
  static ofMinor(minor: bigint, currency: Currency): Money {
    return new Money(minor, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  /**
   * Parse a decimal string.
   *
   * Rejects any value that can't be **exactly** represented in that
   * currency's minor unit: "10.001" under SGD is an error, not a rounding
   * decision silently made on the caller's behalf. Thousands-separator
   * commas are rejected too — "1,200" means different things in different
   * locales (in some it's 1.2), and guessing wrong even once is a
   * misposted entry.
   */
  static parse(text: string, currency: Currency): Money {
    const raw = String(text).trim();
    if (raw.includes(',')) {
      throw new InvalidAmountError(
        `amount ${JSON.stringify(raw)} contains a comma; ` +
          `write it without thousands separators (e.g. "1200.00")`,
      );
    }
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
    if (!m) {
      throw new InvalidAmountError(
        `cannot parse amount ${JSON.stringify(text)}; expected a decimal like "125.50"`,
      );
    }
    const [, sign, whole, frac = ''] = m;
    if (frac.length > currency.decimals) {
      throw new InvalidAmountError(
        `${raw} has ${frac.length} decimal places but ${currency.code} allows ` +
          `${currency.decimals}; refusing to round silently`,
      );
    }
    const scaled =
      BigInt(whole!) * 10n ** BigInt(currency.decimals) +
      BigInt(frac.padEnd(currency.decimals, '0') || '0');
    return new Money(sign === '-' ? -scaled : scaled, currency);
  }

  /**
   * Safely parse from a JSON value.
   *
   * Explicitly rejects a JS number — JSON.parse turns 125.50 into a double
   * that's already imprecise, and validating it here is too late. So the
   * protocol rule is: **amounts are always strings in JSON**.
   */
  static fromJson(value: unknown, currency: Currency): Money {
    if (typeof value === 'number') {
      throw new InvalidAmountError(
        `amount must be a string, not a JSON number (got ${value}); ` +
          `JSON numbers are floats and lose precision before we ever see them. ` +
          `Send "${value}" instead of ${value}.`,
      );
    }
    if (typeof value === 'bigint') return new Money(value, currency);
    if (typeof value === 'string') return Money.parse(value, currency);
    throw new InvalidAmountError(`amount must be a decimal string, got ${typeof value}`);
  }

  private sameCurrency(other: Money): void {
    if (other.currency.code !== this.currency.code) {
      throw new CurrencyMismatchError(
        `${this.currency.code} vs ${other.currency.code}; ` +
          `one book holds exactly one currency — open a separate book`,
      );
    }
  }

  add(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  equals(other: Money): boolean {
    return this.currency.code === other.currency.code && this.minor === other.minor;
  }

  isZero(): boolean     { return this.minor === 0n; }
  isNegative(): boolean { return this.minor <   0n; }
  isPositive(): boolean { return this.minor >   0n; }

  /**
   * Allocate by integer ratio without losing a single minor unit (largest
   * remainder method).
   *
   * allocate([1,1,1]) on S$100.00 gives [33.34, 33.33, 33.33] — which sums
   * back to **exactly** the original value. This is precisely where naive
   * code using percentages plus rounding gets it wrong: three "a third of
   * 100" figures add up to 99.99 or 100.01.
   */
  allocate(ratios: readonly number[]): Money[] {
    if (ratios.length === 0 || ratios.some((r) => !Number.isInteger(r) || r < 0)) {
      throw new InvalidAmountError('ratios must be non-negative integers');
    }
    const total = ratios.reduce((a, b) => a + b, 0);
    if (total === 0) throw new InvalidAmountError('ratios must not sum to zero');

    const totalBig = BigInt(total);
    const shares = ratios.map((r) => (this.minor * BigInt(r)) / totalBig);
    let remainder = this.minor - shares.reduce((a, b) => a + b, 0n);

    // Hand out the remainder one minor unit at a time; for a negative
    // amount the remainder is negative, so step by -1.
    //
    // Only participants with a non-zero ratio are eligible. Rotating over
    // every index hands a cent to someone entitled to nothing:
    // allocate([0, 1, 2]) of 1.00 would return 0.01/0.33/0.66 instead of
    // 0.00/0.33/0.67. A zero share must stay zero — someone with no
    // entitlement receiving money is not a rounding detail, it is a wrong
    // number with a name attached to it.
    const eligible = ratios.reduce<number[]>((acc, r, i) => (r > 0 ? (acc.push(i), acc) : acc), []);
    const step = remainder < 0n ? -1n : 1n;
    const out = [...shares];
    let k = 0;
    while (remainder !== 0n) {
      const i = eligible[k % eligible.length]!;
      out[i] = out[i]! + step;
      remainder -= step;
      k++;
    }
    return out.map((minor) => new Money(minor, this.currency));
  }

  /**
   * Convert to another currency at a stated rate, exactly.
   *
   * The rate is given as a decimal string and handled as a fraction, so there
   * is no float anywhere: "1.0811" becomes 10811/10000 and the arithmetic is
   * integer throughout, rounded half-up once at the end. Doing this with
   * JavaScript numbers is how a converted amount ends up a cent away from what
   * the bank charged, and a ledger that is a cent out does not balance.
   *
   * Exposed because multiplication is the other piece of arithmetic a model
   * gets quietly wrong, alongside division.
   */
  convert(rate: string, to: Currency): Money {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(rate).trim());
    if (!m) {
      throw new InvalidAmountError(
        `unusable exchange rate ${JSON.stringify(rate)}; give it as a positive decimal like "1.0811"`);
    }
    const [, whole, frac = ''] = m;
    const numerator = BigInt(whole! + frac);
    const denominator = 10n ** BigInt(frac.length);
    if (numerator === 0n) throw new InvalidAmountError('an exchange rate of zero converts everything to nothing');

    // Scale between the two currencies' minor units, then apply the rate.
    // Everything stays integer; one half-up rounding at the very end.
    const scaleUp = 10n ** BigInt(Math.max(0, to.decimals - this.currency.decimals));
    const scaleDown = 10n ** BigInt(Math.max(0, this.currency.decimals - to.decimals));
    const num = this.minor * numerator * scaleUp;
    const den = denominator * scaleDown;
    const neg = num < 0n;
    const abs = neg ? -num : num;
    const q = abs / den;
    const rounded = abs % den * 2n >= den ? q + 1n : q;
    return new Money(neg ? -rounded : rounded, to);
  }

  /** "125.50" / "-3.07" / "1200" (JPY) — for display and reporting */
  format(): string {
    const neg = this.minor < 0n;
    const abs = neg ? -this.minor : this.minor;
    if (this.currency.decimals === 0) return `${neg ? '-' : ''}${abs}`;
    const scale = 10n ** BigInt(this.currency.decimals);
    const whole = abs / scale;
    const frac = (abs % scale).toString().padStart(this.currency.decimals, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
  }

  /** Always serializes to a string in JSON, never degrades to a number */
  toJSON(): string {
    return this.format();
  }

  toString(): string {
    return `${this.currency.code} ${this.format()}`;
  }
}
