// Pure mortgage math shared by the loot-core engine (splitting a payment) and
// the desktop-client account page (schedule, progress, payoff calculator).
// Every money value is an integer number of cents; rates are annual fractions
// (0.07 == 7%). Nothing here touches the database or the clock — pass the
// numbers in, get numbers out — so it stays trivially testable.

export type EscrowPeriod = {
  effectiveDate: string; // yyyy-mm-dd
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
};

export type EscrowAmounts = {
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
};

export type ScheduleRow = {
  index: number; // 1-based, counting forward from the starting balance
  date: string | null;
  principal: number;
  interest: number;
  escrow: number;
  balance: number; // remaining balance after this payment
};

export function monthlyRate(annualRate: number): number {
  return annualRate / 12;
}

// Interest portion of the next payment: balance times the monthly rate. Matches
// how the servicer bills interest (on the balance before the payment posts).
export function monthlyInterest(balance: number, annualRate: number): number {
  return Math.round((balance * annualRate) / 12);
}

// Standard fully-amortizing principal+interest payment for a loan.
export function computePayment(
  principal: number,
  annualRate: number,
  termMonths: number,
): number {
  if (termMonths <= 0) {
    return 0;
  }
  const r = monthlyRate(annualRate);
  if (r === 0) {
    return Math.round(principal / termMonths);
  }
  const factor = Math.pow(1 + r, termMonths);
  return Math.round((principal * r * factor) / (factor - 1));
}

// Add whole months to a yyyy-mm-dd date without pulling in the clock.
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = new Date(y, m - 1 + n, d);
  const yy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Project `count` payments forward from a starting balance. Each row's interest
// is computed on the balance before that payment, the rest of the P&I payment
// is principal, and escrow is looked up per row (defaults to 0).
export function buildSchedule(opts: {
  balance: number;
  annualRate: number;
  piPayment: number;
  count: number;
  startDate?: string | null;
  escrowForRow?: (date: string | null, index: number) => number;
}): ScheduleRow[] {
  const { balance, annualRate, piPayment, count, startDate, escrowForRow } =
    opts;
  const rows: ScheduleRow[] = [];
  let remaining = balance;

  for (let i = 1; i <= count && remaining > 0; i++) {
    const interest = monthlyInterest(remaining, annualRate);
    let principal = piPayment - interest;
    if (principal <= 0) {
      // Payment doesn't even cover interest — nothing amortizes, bail out
      // rather than loop forever on a growing balance.
      break;
    }
    if (principal > remaining) {
      principal = remaining;
    }
    remaining -= principal;
    const date = startDate ? addMonths(startDate, i - 1) : null;
    rows.push({
      index: i,
      date,
      principal,
      interest,
      escrow: escrowForRow ? escrowForRow(date, i) : 0,
      balance: remaining,
    });
  }

  return rows;
}

// Payments remaining to reach a zero balance at a given P&I payment. Returns
// Infinity when the payment can't cover interest (loan never amortizes).
export function payoffMonths(
  balance: number,
  annualRate: number,
  piPayment: number,
): number {
  if (balance <= 0) {
    return 0;
  }
  const r = monthlyRate(annualRate);
  if (r === 0) {
    return Math.ceil(balance / piPayment);
  }
  if (piPayment <= balance * r) {
    return Infinity;
  }
  return Math.ceil(
    Math.log(piPayment / (piPayment - balance * r)) / Math.log(1 + r),
  );
}

// How much sooner the loan is paid off, and how much interest is saved, by
// adding `extra` cents of principal to every payment.
export function payoffSavings(
  balance: number,
  annualRate: number,
  piPayment: number,
  extra: number,
): { monthsSaved: number; interestSaved: number } {
  const baseMonths = payoffMonths(balance, annualRate, piPayment);
  const newMonths = payoffMonths(balance, annualRate, piPayment + extra);
  if (baseMonths === Infinity || newMonths === Infinity) {
    return { monthsSaved: 0, interestSaved: 0 };
  }
  const baseInterest = baseMonths * piPayment - balance;
  const newInterest = newMonths * (piPayment + extra) - balance;
  return {
    monthsSaved: baseMonths - newMonths,
    interestSaved: Math.max(0, Math.round(baseInterest - newInterest)),
  };
}

// Escrow amounts in force on a given date: the latest period that has taken
// effect by then. If the date predates every period (e.g. an old payment), fall
// back to the earliest period so a split still produces sensible numbers.
export function escrowForDate(
  periods: EscrowPeriod[],
  date: string,
): EscrowAmounts {
  let chosen: EscrowPeriod | null = null;
  for (const p of periods) {
    if (
      p.effectiveDate <= date &&
      (!chosen || p.effectiveDate > chosen.effectiveDate)
    ) {
      chosen = p;
    }
  }
  if (!chosen && periods.length > 0) {
    chosen = periods.reduce((a, b) =>
      a.effectiveDate <= b.effectiveDate ? a : b,
    );
  }
  return {
    propertyTaxMonthly: chosen?.propertyTaxMonthly ?? 0,
    homeInsuranceMonthly: chosen?.homeInsuranceMonthly ?? 0,
    pmiMonthly: chosen?.pmiMonthly ?? 0,
  };
}

export function escrowTotal(amounts: EscrowAmounts): number {
  return (
    amounts.propertyTaxMonthly +
    amounts.homeInsuranceMonthly +
    amounts.pmiMonthly
  );
}
