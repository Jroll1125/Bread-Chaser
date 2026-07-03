import type { CategoryGroupEntity } from './category-group';

export type CategoryEntity = {
  id: string;
  name: string;
  is_income?: boolean;
  group: CategoryGroupEntity['id'];
  goal_def?: string;
  cleanup_def?: string;
  template_settings?: { source: 'notes' | 'ui' };
  sort_order?: number;
  tombstone?: boolean;
  hidden?: boolean;
  // Lunch Money-style behavior flags: not budgeted at all / omitted from
  // report and group totals.
  exclude_from_budget?: boolean;
  exclude_from_totals?: boolean;
};
