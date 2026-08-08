// Money-layer tests — the focus is what gets rejected, not what can be computed
// Run: node tests/money.mjs

import { Money, currencyOf, InvalidAmountError } from '../src/money.ts';

let pass = 0, fail = 0;
const ok  = (n, e = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${e ? '  ' + e : ''}`); };
const bad = (n, w)      => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}  → ${w}`); };
const eq  = (n, a, b)   => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${b}, got ${a}`));
const rejects = (n, fn) => {
  try { fn(); bad(n, 'should have been rejected but succeeded'); }
  catch (e) { ok(n, 'rejected: ' + e.message.split(';')[0]); }
};

const SGD = currencyOf('SGD');
const JPY = currencyOf('JPY');
const USD = currencyOf('USD');

console.log('\n\x1b[1mA. Parsing\x1b[0m');
eq('A1 "125.50" → 12550 minor units', Money.parse('125.50', SGD).minor, 12550n);
eq('A2 "0.01" → 1 minor unit',       Money.parse('0.01', SGD).minor, 1n);
eq('A3 "1200" → 120000 minor units',  Money.parse('1200', SGD).minor, 120000n);
eq('A4 "-3.07" → -307 minor units',   Money.parse('-3.07', SGD).minor, -307n);
eq('A5 JPY "1200" → 1200',   Money.parse('1200', JPY).minor, 1200n);

console.log('\n\x1b[1mB. Reject floats and ambiguity right at the boundary\x1b[0m');
rejects('B1 over-precision "10.001" (SGD only has 2 decimal places)', () => Money.parse('10.001', SGD));
rejects('B2 JPY does not accept a decimal "10.5"',           () => Money.parse('10.5', JPY));
rejects('B3 thousands-separator comma "1,200"',              () => Money.parse('1,200', SGD));
rejects('B4 empty string',                        () => Money.parse('', SGD));
rejects('B5 non-numeric "abc"',                    () => Money.parse('abc', SGD));
rejects('B6 scientific notation "1e3"',                () => Money.parse('1e3', SGD));
rejects('B7 JSON number (precision is already lost)',      () => Money.fromJson(125.5, SGD));
eq('B8 a JSON string is fine',  Money.fromJson('125.50', SGD).minor, 12550n);
eq('B9 a bigint is fine',       Money.fromJson(12550n, SGD).minor, 12550n);

console.log('\n\x1b[1mC. No fromNumber — floats simply cannot get in\x1b[0m');
eq('C1 Money.fromNumber does not exist', typeof Money.fromNumber, 'undefined');
// This missing API is deliberate. With it, 0.1+0.2 !== 0.3 would leak straight into the ledger.

console.log('\n\x1b[1mD. Arithmetic is exact\x1b[0m');
{
  // The classic float trap: 0.1 + 0.2 is 0.30000000000000004 in JS
  const a = Money.parse('0.10', SGD), b = Money.parse('0.20', SGD);
  eq('D1 0.10 + 0.20 is exactly 0.30', a.add(b).format(), '0.30');
  eq('D2 and not 0.30000000000000004', a.add(b).minor, 30n);

  // Summing 0.1 ten times — floats would drift here
  let acc = Money.zero(SGD);
  for (let i = 0; i < 10; i++) acc = acc.add(Money.parse('0.10', SGD));
  eq('D3 summing 0.10 ten times is exactly 1.00', acc.format(), '1.00');

  eq('D4 subtraction', Money.parse('100.00', SGD).subtract(Money.parse('33.33', SGD)).format(), '66.67');
}

console.log('\n\x1b[1mE. Allocation loses not a single cent (largest-remainder method)\x1b[0m');
{
  const hundred = Money.parse('100.00', SGD);
  const three = hundred.allocate([1, 1, 1]);
  eq('E1 split three ways = 33.34/33.33/33.33', three.map((m) => m.format()).join('/'), '33.34/33.33/33.33');
  eq('E2 the three parts sum back to exactly the original value',
     three.reduce((s, m) => s.add(m), Money.zero(SGD)).format(), '100.00');

  const uneven = hundred.allocate([3, 1]);
  eq('E3 split 3:1 = 75.00/25.00', uneven.map((m) => m.format()).join('/'), '75.00/25.00');

  const one = Money.parse('0.01', SGD).allocate([1, 1, 1]);
  eq('E4 splitting 1 cent three ways = 0.01/0.00/0.00', one.map((m) => m.format()).join('/'), '0.01/0.00/0.00');
  eq('E5 and the total is still 0.01',
     one.reduce((s, m) => s.add(m), Money.zero(SGD)).format(), '0.01');

  // Regression: the remainder used to rotate over every index, so a
  // participant with ratio 0 received a cent they were not entitled to.
  const withZero = hundred.allocate([0, 1, 2]);
  eq('E6a a zero ratio receives exactly zero', withZero[0].format(), '0.00');
  // The odd cent goes to the first entitled party (deterministic), never to
  // the one with ratio 0.
  eq('E6b and the odd cent goes to an entitled party',
     withZero.map((m) => m.format()).join('/'), '0.00/33.34/66.66');
  eq('E6c the parts still sum to the original',
     withZero.reduce((s, m) => s.add(m), Money.zero(SGD)).format(), '100.00');
  const manyZeros = Money.parse('0.05', SGD).allocate([0, 0, 1]);
  eq('E6d several zeros stay zero', manyZeros.map((m) => m.format()).join('/'), '0.00/0.00/0.05');

  const negative = Money.parse('-100.00', SGD).allocate([1, 1, 1]);
  eq('E6 negative amounts allocate without losing anything either',
     negative.reduce((s, m) => s.add(m), Money.zero(SGD)).format(), '-100.00');
}

console.log('\n\x1b[1mE2. Exact conversion\x1b[0m');
{
  const EUR = currencyOf('EUR'), JPY = currencyOf('JPY');
  eq('E2a 92.50 EUR at 1.0811', Money.parse('92.50', EUR).convert('1.0811', SGD).format(), '100.00');
  eq('E2b into a zero-decimal currency', Money.parse('1000.00', EUR).convert('163.42', JPY).format(), '163420');
  eq('E2c out of a zero-decimal currency', Money.parse('100', JPY).convert('0.0064', SGD).format(), '0.64');
  // 0.29 * 1.15 is 0.3335 exactly; JS floats give 0.33350000000000005
  eq('E2d exact where floats are not', Money.parse('0.29', EUR).convert('1.15', SGD).format(), '0.33');
  eq('E2e a rate of 1 is identity', Money.parse('12.34', EUR).convert('1', SGD).format(), '12.34');
  eq('E2f zero converts to zero', Money.zero(EUR).convert('1.0811', SGD).format(), '0.00');
  eq('E2g negatives convert too', Money.parse('-50.00', EUR).convert('1.10', SGD).format(), '-55.00');
  rejects('E2h a zero rate is refused', () => Money.parse('1.00', EUR).convert('0', SGD));
  rejects('E2i a negative rate is refused', () => Money.parse('1.00', EUR).convert('-1.1', SGD));
  rejects('E2j a non-numeric rate is refused', () => Money.parse('1.00', EUR).convert('abc', SGD));
}

console.log('\n\x1b[1mF. Mixing currencies must throw\x1b[0m');
rejects('F1 SGD + USD', () => Money.parse('1.00', SGD).add(Money.parse('1.00', USD)));
rejects('F2 unknown currency XYZ', () => currencyOf('XYZ'));

console.log('\n\x1b[1mG. Formatting and serialization\x1b[0m');
eq('G1 format pads with a trailing zero',        Money.ofMinor(5n, SGD).format(), '0.05');
eq('G2 JPY has no decimal point',       Money.ofMinor(1200n, JPY).format(), '1200');
eq('G3 toJSON is a string',    JSON.stringify({ amt: Money.parse('125.50', SGD) }), '{"amt":"125.50"}');
eq('G4 toString includes the currency',    Money.parse('125.50', SGD).toString(), 'SGD 125.50');

console.log('\n\x1b[1mH. Large amounts do not overflow (bigint)\x1b[0m');
{
  // JS's Number.MAX_SAFE_INTEGER is 9007199254740991 (about 90 trillion minor units = 900 billion currency units)
  // Past that, a plain number starts losing precision; bigint does not.
  const huge = Money.parse('99999999999999999.99', SGD);
  eq('H1 still exact past MAX_SAFE_INTEGER', huge.format(), '99999999999999999.99');
  eq('H2 adding one cent to a huge amount is still exact',
     huge.add(Money.parse('0.01', SGD)).format(), '100000000000000000.00');
}

console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
