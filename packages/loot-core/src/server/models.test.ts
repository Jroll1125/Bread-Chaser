import { categoryModel } from './models';

import type { CategoryEntity } from '#types/models';

describe('categoryModel', () => {
  // Regression: the Lunch Money-style exclude flags were added to the DB +
  // entity types but not to the AQL categories schema, so category-update
  // threw `Field "exclude_from_budget" does not exist on table categories`
  // (surfaced in the UI as "[object Object]") and the toggles never stuck.
  test('toDb maps the exclude flags on update', () => {
    const row = categoryModel.toDb(
      {
        id: 'c1',
        name: 'Groceries',
        group: 'g1',
        is_income: false,
        exclude_from_budget: true,
        exclude_from_totals: false,
      } as CategoryEntity,
      { update: true },
    );
    expect(row.exclude_from_budget).toBe(1);
    expect(row.exclude_from_totals).toBe(0);
  });

  test('fromDb reads the exclude flags back', () => {
    const entity = categoryModel.fromDb({
      id: 'c1',
      name: 'Groceries',
      cat_group: 'g1',
      is_income: 0,
      hidden: 0,
      exclude_from_budget: 1,
      exclude_from_totals: 0,
      sort_order: 1,
      tombstone: 0,
    } as Parameters<typeof categoryModel.fromDb>[0]);
    expect(entity.exclude_from_budget).toBe(true);
    expect(entity.exclude_from_totals).toBe(false);
  });
});
