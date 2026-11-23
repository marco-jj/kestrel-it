import type { DepreciationMethod, DepreciationType } from '@kestrel-it/shared';

type Schedule = {
  months: number;
  depreciationMin: string | null;
  depreciationType: DepreciationType;
  fiscalYearStartMonth: number | null;
  rateMultiplier: string | null;
};

const dayMs = 86_400_000;
const utcDate = (year: number, month: number, day: number) => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date;
};

export function addCalendarMonths(date: Date, months: number): Date {
  const first = utcDate(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
  const last = utcDate(first.getUTCFullYear(), first.getUTCMonth() + 1, 0);
  first.setUTCDate(Math.min(date.getUTCDate(), last.getUTCDate()));
  return first;
}

function monthsElapsed(from: Date, to: Date) {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  return Math.max(0, months - Number(to.getUTCDate() < from.getUTCDate()));
}

function halfYear(date: Date) {
  const monthDay = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  return {
    fiscalYear: date.getUTCFullYear() - Number(monthDay !== 1231),
    secondHalf: monthDay >= 601 && monthDay < 1231,
  };
}

function cents(value: string): bigint {
  const [whole, fractional = ''] = value.split('.');
  const sign = value.startsWith('-') ? -1n : 1n;
  return BigInt(whole!) * 100n + sign * BigInt(fractional.padEnd(2, '0'));
}

function roundDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

function diminishing(from: Date, to: Date, cost: bigint, schedule: Schedule, floor: bigint) {
  const fiscalMonth = Math.min(12, Math.max(1, schedule.fiscalYearStartMonth ?? 1)) - 1;
  const rate = cents(schedule.rateMultiplier ?? '2') * 12n;
  const divisor = BigInt(schedule.months) * 36_500n;
  // Keep fractions of a cent between fiscal periods and round only the final value.
  const scale = 10n ** 16n;
  let balance = cost * scale;
  let start = from;
  while (start <= to && balance > floor * scale) {
    const nextYear = start.getUTCFullYear() + Number(start.getUTCMonth() >= fiscalMonth);
    const nextFiscalStart = utcDate(nextYear, fiscalMonth, 1).getTime();
    const endExclusive = Math.min(nextFiscalStart, to.getTime() + dayMs);
    const days = BigInt((endExclusive - start.getTime()) / dayMs);
    const remainder = divisor - days * rate;
    if (remainder <= 0n) return floor;
    balance = roundDivide(balance * remainder, divisor);
    start = new Date(endExclusive);
  }
  return roundDivide(balance, scale);
}

export function depreciationValue(
  schedule: Schedule | undefined,
  purchaseCost: string | null,
  purchaseDate: string | null,
  method: DepreciationMethod,
  asOf: string,
): string | null {
  if (purchaseCost === null) return null;
  const cost = cents(purchaseCost);
  if (!schedule || schedule.months <= 0 || !purchaseDate || cost <= 0n || asOf <= purchaseDate)
    return purchaseCost;
  const start = new Date(purchaseDate);
  const end = new Date(asOf);
  const minimum = cents(schedule.depreciationMin ?? '0');
  const residual =
    schedule.depreciationType === 'percent' ? roundDivide(cost * minimum, 10_000n) : minimum;
  const floor = residual < 0n ? 0n : residual > cost ? cost : residual;
  let value: bigint;
  if (method === 'default') {
    const months = BigInt(schedule.months);
    const elapsed = BigInt(Math.min(schedule.months, monthsElapsed(start, end)));
    value = roundDivide(cost * (months - elapsed) + floor * elapsed, months);
  } else if (method === 'diminish') {
    value = diminishing(start, end, cost, schedule, floor);
  } else {
    const bought = halfYear(start);
    const current = halfYear(end);
    const periods = 2 * Math.ceil(schedule.months / 12);
    const elapsed =
      2 * (current.fiscalYear - bought.fiscalYear) -
      Number(method === 'half_1' || bought.secondHalf) +
      Number(current.secondHalf);
    value =
      cost - roundDivide(cost * BigInt(Math.min(periods, Math.max(0, elapsed))), BigInt(periods));
  }
  const book = value < floor ? floor : value > cost ? cost : value;
  return `${book / 100n}.${(book % 100n).toString().padStart(2, '0')}`;
}
