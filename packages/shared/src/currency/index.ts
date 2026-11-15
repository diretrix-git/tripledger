/**
 * Integer Paisa / NPR Currency Utilities
 * 1 NPR = 100 Paisa
 * Never use floating point math for financial storage or calculation.
 */

export const PAISA_PER_NPR = 100;

export function assertValidPaisa(value: number, label = 'Amount'): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer in paisa (received ${String(value)})`);
  }
}

export function assertNonNegativePaisa(value: number, label = 'Amount'): void {
  assertValidPaisa(value, label);
  if (value < 0) {
    throw new Error(`${label} cannot be negative (received ${value} paisa)`);
  }
}

export function assertPositivePaisa(value: number, label = 'Amount'): void {
  assertValidPaisa(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be greater than zero (received ${value} paisa)`);
  }
}

/**
 * Converts a string or number in NPR (e.g. "1250.50" or 1250.5) to exact integer paisa (125050).
 * Rejects inputs with more than 2 decimal places or invalid numeric format.
 */
export function nprToPaisa(nprInput: string | number): number {
  const raw = typeof nprInput === 'number' ? nprInput.toString() : nprInput.trim();
  const normalized = raw.replace(/,/g, '');

  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Invalid NPR currency amount: "${String(nprInput)}". Expected up to 2 decimal places.`);
  }

  const isNegative = normalized.startsWith('-');
  const unsigned = isNegative ? normalized.slice(1) : normalized;
  const [wholePart, fracPart = ''] = unsigned.split('.');

  const wholePaisa = Number.parseInt(wholePart, 10) * PAISA_PER_NPR;
  const paddedFrac = (fracPart + '00').slice(0, 2);
  const fracPaisa = Number.parseInt(paddedFrac, 10);

  const totalPaisa = wholePaisa + fracPaisa;
  const signedPaisa = isNegative ? -totalPaisa : totalPaisa;

  assertValidPaisa(signedPaisa, 'Converted NPR amount');
  return signedPaisa;
}

/**
 * Converts integer paisa to a numeric NPR value strictly for chart axes or input field initialization.
 */
export function paisaToNprNumber(paisa: number): number {
  assertValidPaisa(paisa);
  return paisa / PAISA_PER_NPR;
}

/**
 * Converts integer paisa to a canonical decimal string without currency prefix (e.g. "1250.50" or "1250").
 */
export function paisaToNprString(paisa: number, alwaysShowDecimals = false): string {
  assertValidPaisa(paisa);
  const sign = paisa < 0 ? '-' : '';
  const absPaisa = Math.abs(paisa);
  const whole = Math.floor(absPaisa / PAISA_PER_NPR);
  const remainder = absPaisa % PAISA_PER_NPR;

  if (remainder === 0 && !alwaysShowDecimals) {
    return `${sign}${whole}`;
  }
  return `${sign}${whole}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * Formats integer paisa into human-readable Nepalese Rupees (e.g. "NPR 33,000" or "NPR 1,250.50").
 * Uses South Asian / Nepali grouping (lakhs/crores: 1,00,000) via en-IN locale formatting.
 */
export function formatPaisaToNPR(
  paisa: number,
  options: { showDecimalsIfZero?: boolean; showSign?: boolean } = {}
): string {
  assertValidPaisa(paisa);
  const { showDecimalsIfZero = false, showSign = false } = options;

  const isNegative = paisa < 0;
  const absPaisa = Math.abs(paisa);
  const whole = Math.floor(absPaisa / PAISA_PER_NPR);
  const remainder = absPaisa % PAISA_PER_NPR;

  const formattedWhole = whole.toLocaleString('en-IN');
  const decimalPart =
    remainder > 0 || showDecimalsIfZero ? `.${remainder.toString().padStart(2, '0')}` : '';

  const signPrefix = isNegative ? '-' : showSign && paisa > 0 ? '+' : '';
  return `${signPrefix}NPR ${formattedWhole}${decimalPart}`;
}
