import { normalizeDate, validateStatement } from './statement-extract';

describe('validateStatement', () => {
  it('parses a good extraction into cents', () => {
    const out = validateStatement(
      JSON.stringify({
        interest: 2346.17,
        taxAndInsurance: 537.71,
        statementDate: '2026-06-17',
        dueDate: 'July 16, 2026',
        principalBalance: 402199.91,
      }),
    );
    expect(out).toEqual({
      interest: 234617,
      taxAndInsurance: 53771,
      principalBalance: 40219991,
      statementDate: '2026-06-17',
      dueDate: '2026-07-16',
    });
  });

  it('rejects a zero or missing interest', () => {
    expect(
      validateStatement(
        JSON.stringify({ interest: 0, taxAndInsurance: 349.05 }),
      ),
    ).toBeNull();
    expect(
      validateStatement(JSON.stringify({ taxAndInsurance: 349.05 })),
    ).toBeNull();
  });

  it('allows zero escrow', () => {
    const out = validateStatement(
      JSON.stringify({
        interest: 2346.17,
        taxAndInsurance: 0,
        statementDate: '2026-06-17',
        dueDate: '2026-07-16',
        principalBalance: 402199.91,
      }),
    );
    expect(out?.taxAndInsurance).toBe(0);
  });

  it('returns null on non-JSON', () => {
    expect(validateStatement('not json')).toBeNull();
  });
});

describe('normalizeDate', () => {
  it('handles the formats servicers use', () => {
    expect(normalizeDate('2026-07-16')).toBe('2026-07-16');
    expect(normalizeDate('07/16/26')).toBe('2026-07-16');
    expect(normalizeDate('7/1/2026')).toBe('2026-07-01');
    expect(normalizeDate('July 16, 2026')).toBe('2026-07-16');
    expect(normalizeDate('nonsense')).toBeNull();
    expect(normalizeDate(42)).toBeNull();
  });
});
