import { describe, it, expect } from 'vitest';

import { norm, buildModel, suggestOne, type Seed } from './app';

describe('autocat normalization', () => {
  it('normalizes payee/merchant names to a comparable key', () => {
    expect(norm('DoorDash')).toBe('DOORDASH');
    expect(norm('SPEEDWAY #04412')).toBe('SPEEDWAY');
    expect(norm('onXmaps, Inc.')).toBe('ONXMAPS'); // punctuation + INC dropped
    expect(norm('Joel Lambright')).toBe('JOEL LAMBRIGHT');
  });
});

function seed(): Seed {
  return {
    taxonomy: {},
    payeeModal: {
      DOORDASH: {
        group: 'Food & Dining',
        category: 'Fast Food',
        share: 0.95,
        count: 20,
        ambiguous: false,
        example: 'DoorDash',
      },
    },
    records: [
      { payee: 'SPEEDWAY', group: 'Auto & Transport', category: 'Gas & Fuel', sign: -1, count: 15 },
      { payee: 'DOORDASH', group: 'Food & Dining', category: 'Fast Food', sign: -1, count: 20 },
      { payee: 'AMAZON', group: 'Shopping', category: 'Electronics & Software', sign: -1, count: 4 },
      { payee: 'AMAZON', group: 'Shopping', category: 'Books', sign: -1, count: 6 },
    ],
  };
}

describe('autocat suggestions', () => {
  const model = buildModel(seed());

  it('tier 1: uses the payee modal category when dominant', () => {
    const s = suggestOne('DOORDASH', -1, model);
    expect(s?.via).toBe('payee');
    expect(s?.group).toBe('Food & Dining');
    expect(s?.category).toBe('Fast Food');
  });

  it('tier 2: falls back to the token model for a payee not in the modal map', () => {
    const s = suggestOne('SPEEDWAY', -1, model);
    expect(s?.via).toBe('tokens');
    expect(s?.category).toBe('Gas & Fuel');
  });

  it('tier 2: picks the most-common category for the token', () => {
    // AMAZON: Books (6) beats Electronics (4).
    const s = suggestOne('AMAZON', -1, model);
    expect(s?.via).toBe('tokens');
    expect(s?.category).toBe('Books');
  });

  it('respects the amount sign (an expense-only token has no income match)', () => {
    expect(suggestOne('SPEEDWAY', 1, model)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(suggestOne('ZZQWX RANDOM THING', -1, model)).toBeNull();
  });
});
