import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';

import { Error as ErrorAlert } from '#components/alerts';
import { AutoCategorizePanel } from '#components/categories/AutoCategorizePanel';
import { MOBILE_NAV_HEIGHT } from '#components/mobile/MobileNavTabs';
import { Page } from '#components/Page';
import { useCategories } from '#hooks/useCategories';
import { useGlobalPref } from '#hooks/useGlobalPref';

// Renaming saves on blur/Enter; a same-value blur is a no-op.
function NameEditor({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <Input
      value={value}
      onChangeValue={setValue}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== name) {
          onRename(trimmed);
        } else {
          setValue(name);
        }
      }}
      style={{
        border: 'none',
        backgroundColor: 'transparent',
        fontWeight: 500,
        padding: '2px 4px',
        maxWidth: 260,
      }}
    />
  );
}

function FlagToggle({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        color: theme.pageTextSubdued,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

// Deleting is a two-click affair instead of a modal: Delete → Confirm.
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [arming, setArming] = useState(false);
  return arming ? (
    <Button
      variant="bare"
      style={{ color: theme.errorText, fontSize: 12 }}
      onPress={onDelete}
    >
      <Trans>Confirm delete</Trans>
    </Button>
  ) : (
    <Button
      variant="bare"
      style={{ fontSize: 12 }}
      onPress={() => setArming(true)}
    >
      <Trans>Delete</Trans>
    </Button>
  );
}

export function CategoriesPage() {
  const { t } = useTranslation();
  const [floatingSidebar] = useGlobalPref('floatingSidebar');
  const { isNarrowWidth } = useResponsive();
  const { data, refetch } = useCategories();
  const [error, setError] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newCategoryFor, setNewCategoryFor] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');

  const groups: CategoryGroupEntity[] = data?.grouped ?? [];

  const act = async (fn: () => Promise<unknown>, rebuildBudget = false) => {
    setError(null);
    try {
      await fn();
      if (rebuildBudget) {
        // Structure changes (new/removed category, or the exclude-from-budget/
        // -totals flags) must rebuild the budget dependency graph, not just
        // recompute values — otherwise group/month totals keep summing the old
        // set of categories. reset-budget-cache only recomputes, so use the
        // structural rebuild here.
        await send('budget-rebuild-structure');
      }
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateCategory = (
    cat: CategoryEntity,
    patch: Partial<CategoryEntity>,
    rebuildBudget = false,
  ) =>
    act(
      () => send('category-update', { ...cat, ...patch }),
      rebuildBudget,
    );

  return (
    <Page
      header={t('Categories')}
      style={{
        marginInline: floatingSidebar && !isNarrowWidth ? 'auto' : 0,
        paddingBottom: MOBILE_NAV_HEIGHT,
      }}
    >
      <View
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          marginTop: '1em',
        }}
      >
        {/* flexShrink: 0 keeps the list at full height so the scroll
            container above actually scrolls instead of compressing it. */}
        <View style={{ gap: 16, maxWidth: 900, paddingBottom: 24, flexShrink: 0 }}>
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Manage category groups and categories in one place. Income
            categories count as earnings; a category excluded from the budget
            is never budgeted (but stays usable on transactions); a category
            excluded from totals is left out of reports and group totals.
          </Trans>
        </Text>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        <AutoCategorizePanel />

        {groups.map(group => (
          <View
            key={group.id}
            style={{
              border: '1px solid ' + theme.tableBorder,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                backgroundColor: theme.tableRowHeaderBackground,
              }}
            >
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
              >
                <NameEditor
                  name={group.name}
                  onRename={name =>
                    act(() =>
                      send('category-group-update', { ...group, name }),
                    )
                  }
                />
                {group.is_income && (
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.pillText,
                      backgroundColor: theme.pillBackground,
                      borderRadius: 4,
                      padding: '1px 6px',
                    }}
                  >
                    <Trans>Income</Trans>
                  </Text>
                )}
              </View>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
              >
                <Button
                  variant="bare"
                  style={{ fontSize: 12 }}
                  onPress={() => {
                    setNewCategoryFor(
                      newCategoryFor === group.id ? null : group.id,
                    );
                    setNewCategoryName('');
                  }}
                >
                  <Trans>Add category</Trans>
                </Button>
                {!group.is_income && (
                  <DeleteButton
                    onDelete={() =>
                      act(
                        () => send('category-group-delete', { id: group.id }),
                        true,
                      )
                    }
                  />
                )}
              </View>
            </View>

            {newCategoryFor === group.id && (
              <View
                style={{
                  flexDirection: 'row',
                  gap: 8,
                  padding: '6px 12px',
                  borderTop: '1px solid ' + theme.tableBorder,
                }}
              >
                <Input
                  value={newCategoryName}
                  placeholder={t('New category name')}
                  onChangeValue={setNewCategoryName}
                  style={{ maxWidth: 260 }}
                />
                <Button
                  variant="primary"
                  isDisabled={!newCategoryName.trim()}
                  onPress={() => {
                    void act(async () => {
                      await send('category-create', {
                        name: newCategoryName.trim(),
                        groupId: group.id,
                        isIncome: !!group.is_income,
                      });
                      setNewCategoryFor(null);
                      setNewCategoryName('');
                    }, true);
                  }}
                >
                  <Trans>Create</Trans>
                </Button>
              </View>
            )}

            {(group.categories ?? []).map(cat => (
              <View
                key={cat.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '4px 12px',
                  borderTop: '1px solid ' + theme.tableBorder,
                  opacity: cat.hidden ? 0.6 : 1,
                }}
              >
                <NameEditor
                  name={cat.name}
                  onRename={name => updateCategory(cat, { name })}
                />
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 14,
                    flexShrink: 0,
                  }}
                >
                  <FlagToggle
                    label={t('Income')}
                    title={t('Treat this category as income')}
                    checked={!!cat.is_income}
                    onChange={checked =>
                      updateCategory(cat, { is_income: checked }, true)
                    }
                  />
                  <FlagToggle
                    label={t('No budget')}
                    title={t(
                      'Exclude from the budget — never budgeted, still usable on transactions',
                    )}
                    checked={!!cat.exclude_from_budget}
                    onChange={checked =>
                      updateCategory(
                        cat,
                        { exclude_from_budget: checked },
                        true,
                      )
                    }
                  />
                  <FlagToggle
                    label={t('No totals')}
                    title={t(
                      'Exclude from totals — omitted from reports and group totals',
                    )}
                    checked={!!cat.exclude_from_totals}
                    onChange={checked =>
                      updateCategory(
                        cat,
                        { exclude_from_totals: checked },
                        true,
                      )
                    }
                  />
                  <FlagToggle
                    label={t('Hidden')}
                    title={t('Hide from budget lists (still counts in totals)')}
                    checked={!!cat.hidden}
                    onChange={checked =>
                      updateCategory(cat, { hidden: checked })
                    }
                  />
                  <DeleteButton
                    onDelete={() =>
                      act(() => send('category-delete', { id: cat.id }), true)
                    }
                  />
                </View>
              </View>
            ))}
          </View>
        ))}

        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Input
            value={newGroupName}
            placeholder={t('New group name')}
            onChangeValue={setNewGroupName}
            style={{ maxWidth: 260 }}
          />
          <Button
            isDisabled={!newGroupName.trim()}
            onPress={() => {
              void act(async () => {
                await send('category-group-create', {
                  name: newGroupName.trim(),
                });
                setNewGroupName('');
              });
            }}
          >
            <Trans>Add group</Trans>
          </Button>
        </View>
        </View>
      </View>
    </Page>
  );
}
