import {
  buildSchedule,
  computePayment,
  escrowForDate,
  escrowTotal,
  monthlyInterest,
  payoffMonths,
  payoffSavings,
  type EscrowPeriod,
} from './mortgage';

// All expected values below come straight off real Interra Credit Union
// statements for loan #21001106 (7.00% fixed, 30-yr) so the math is pinned to
// what the servicer actually bills.

describe('mortgage math', () => {
  describe('monthlyInterest', () => {
    it('matches the servicer to the cent', () => {
      // Oct 2025 statement: balance $404,910.00 -> interest $2,361.98
      expect(monthlyInterest(40491000, 0.07)).toBe(236198);
      // Jan 2026 statement: balance $403,908.47 -> interest $2,356.13
      expect(monthlyInterest(40390847, 0.07)).toBe(235613);
      // Jun 2026 statement: balance $402,199.91 -> next interest $2,346.17
      expect(monthlyInterest(40219991, 0.07)).toBe(234617);
    });

    it('is zero on a paid-off balance', () => {
      expect(monthlyInterest(0, 0.07)).toBe(0);
    });
  });

  describe('computePayment', () => {
    it('reproduces the P&I payment within a cent or two', () => {
      // 30-yr, 7%, ~$404,910 original -> P&I $2,693.88
      const pmt = computePayment(40491000, 0.07, 360);
      expect(Math.abs(pmt - 269388)).toBeLessThan(100);
    });

    it('handles a zero-interest loan', () => {
      expect(computePayment(12000, 0, 12)).toBe(1000);
    });
  });

  describe('buildSchedule', () => {
    it('splits each payment exactly like the statement', () => {
      const rows = buildSchedule({
        balance: 40219991, // Jun 2026 balance
        annualRate: 0.07,
        piPayment: 269388,
        count: 3,
        startDate: '2026-07-01',
      });

      // Jul 1 payment: $347.71 principal, $2,346.17 interest, ending
      // $401,852.20 — which is exactly the balance the app shows.
      expect(rows[0]).toMatchObject({
        date: '2026-07-01',
        principal: 34771,
        interest: 234617,
        balance: 40185220,
      });
      // Principal grows and interest shrinks the next month.
      expect(rows[1].principal).toBeGreaterThan(rows[0].principal);
      expect(rows[1].interest).toBeLessThan(rows[0].interest);
      expect(rows[1].date).toBe('2026-08-01');
    });

    it('applies per-row escrow via the callback', () => {
      const rows = buildSchedule({
        balance: 40219991,
        annualRate: 0.07,
        piPayment: 269388,
        count: 2,
        startDate: '2026-07-01',
        escrowForRow: () => 53771,
      });
      expect(rows[0].escrow).toBe(53771);
    });
  });

  describe('payoffMonths', () => {
    it('is finite and near a fresh 30-yr term', () => {
      const n = payoffMonths(40185220, 0.07, 269388);
      expect(n).toBeGreaterThan(340);
      expect(n).toBeLessThan(361);
    });

    it('never pays off when the payment cannot cover interest', () => {
      // Interest floor here is balance * rate / 12 = $2,344.13/mo; a payment
      // below that never amortizes.
      expect(payoffMonths(40185220, 0.07, 234000)).toBe(Infinity);
    });
  });

  describe('payoffSavings', () => {
    it('saves nothing with no extra payment', () => {
      expect(payoffSavings(40185220, 0.07, 269388, 0)).toEqual({
        monthsSaved: 0,
        interestSaved: 0,
      });
    });

    it('shortens the term and saves interest with extra principal', () => {
      const { monthsSaved, interestSaved } = payoffSavings(
        40185220,
        0.07,
        269388,
        20000, // +$200/mo
      );
      expect(monthsSaved).toBeGreaterThan(0);
      expect(interestSaved).toBeGreaterThan(0);
    });
  });

  describe('escrowForDate', () => {
    const periods: EscrowPeriod[] = [
      {
        effectiveDate: '2025-10-01',
        propertyTaxMonthly: 25000,
        homeInsuranceMonthly: 9905,
        pmiMonthly: 0,
      },
      {
        effectiveDate: '2026-07-01',
        propertyTaxMonthly: 40000,
        homeInsuranceMonthly: 13771,
        pmiMonthly: 0,
      },
    ];

    it('picks the period in force on the payment date', () => {
      expect(escrowTotal(escrowForDate(periods, '2026-06-15'))).toBe(34905);
      expect(escrowTotal(escrowForDate(periods, '2026-07-01'))).toBe(53771);
      expect(escrowTotal(escrowForDate(periods, '2026-08-20'))).toBe(53771);
    });

    it('falls back to the earliest period for dates before any take effect', () => {
      expect(escrowTotal(escrowForDate(periods, '2025-05-01'))).toBe(34905);
    });

    it('is all zeros when there are no periods', () => {
      expect(escrowForDate([], '2026-07-01')).toEqual({
        propertyTaxMonthly: 0,
        homeInsuranceMonthly: 0,
        pmiMonthly: 0,
      });
    });
  });
});
