import React, { Fragment, useMemo } from 'react';
import type {
  ComponentProps,
  ComponentPropsWithoutRef,
  ComponentType,
  CSSProperties,
  ReactElement,
  ReactNode,
  SVGProps,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgAdd } from '@actual-app/components/icons/v1';
import { SvgSplit } from '@actual-app/components/icons/v0';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { TextOneLine } from '@actual-app/components/text-one-line';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { getNormalisedString } from '@actual-app/core/shared/normalisation';
import { integerToCurrency } from '@actual-app/core/shared/util';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';
import { css, cx } from '@emotion/css';

import { useEnvelopeSheetValue } from '#components/budget/envelope/EnvelopeBudgetComponents';
import { makeAmountFullStyle } from '#components/budget/util';
import { FinancialText } from '#components/FinancialText';
import { useCategories } from '#hooks/useCategories';
import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { envelopeBudget, trackingBudget } from '#spreadsheet/bindings';

import { Autocomplete } from './Autocomplete';
import { filterCategorySuggestions } from './filterCategorySuggestions';
import { ItemHeader } from './ItemHeader';

type CategoryAutocompleteItem = Omit<CategoryEntity, 'group'> & {
  group?: CategoryGroupEntity;
};

type CategoryListProps = {
  items: CategoryAutocompleteItem[];
  getItemProps?: (arg: {
    item: CategoryAutocompleteItem;
  }) => Partial<ComponentProps<typeof View>>;
  highlightedIndex: number;
  embedded?: boolean;
  footer?: ReactNode;
  renderSplitTransactionButton?: (
    props: ComponentPropsWithoutRef<typeof SplitTransactionButton>,
  ) => ReactElement<typeof SplitTransactionButton>;
  renderCategoryItemGroupHeader?: (
    props: ComponentPropsWithoutRef<typeof ItemHeader>,
  ) => ReactElement<typeof ItemHeader>;
  renderCategoryItem?: (
    props: ComponentPropsWithoutRef<typeof CategoryItem>,
  ) => ReactElement<typeof CategoryItem>;
  showHiddenItems?: boolean;
  showBalances?: boolean;
};
function CategoryList({
  items,
  getItemProps,
  highlightedIndex,
  embedded,
  footer,
  renderSplitTransactionButton = defaultRenderSplitTransactionButton,
  renderCategoryItemGroupHeader = defaultRenderCategoryItemGroupHeader,
  renderCategoryItem = defaultRenderCategoryItem,
  showHiddenItems,
  showBalances,
}: CategoryListProps) {
  const { t } = useTranslation();
  const { splitTransaction, createCategory, groupedCategories } = useMemo(() => {
    return items.reduce(
      (acc, item, index) => {
        if (item.id === 'split') {
          acc.splitTransaction = { ...item, highlightedIndex: index };
          return acc;
        }
        if (item.id === 'new') {
          acc.createCategory = { ...item, highlightedIndex: index };
          return acc;
        }

        const groupId = item.group?.id || '';
        const existing = acc.groupedCategories.find(
          x => x.group?.id === groupId,
        );
        const itemWithIndex = {
          ...item,
          highlightedIndex: index,
        };

        if (!existing) {
          acc.groupedCategories.push({
            group: item.group ?? null,
            categories: [itemWithIndex],
          });
        } else {
          existing.categories.push(itemWithIndex);
        }

        return acc;
      },
      {
        splitTransaction: null,
        createCategory: null,
        groupedCategories: [],
      } as {
        splitTransaction:
          | (CategoryAutocompleteItem & {
              highlightedIndex: number;
            })
          | null;
        createCategory:
          | (CategoryAutocompleteItem & {
              highlightedIndex: number;
            })
          | null;
        groupedCategories: Array<{
          group: CategoryGroupEntity | null;
          categories: Array<
            CategoryAutocompleteItem & { highlightedIndex: number }
          >;
        }>;
      },
    );
  }, [items]);

  return (
    <View>
      <View
        style={{
          overflowY: 'auto',
          willChange: 'transform',
          padding: '5px 0',
          ...(!embedded && { maxHeight: 175 }),
        }}
      >
        {splitTransaction &&
          (() => {
            const splitButtonProps = getItemProps
              ? getItemProps({ item: splitTransaction })
              : {};
            const { onClick, ...restSplitButtonProps } = splitButtonProps;
            return renderSplitTransactionButton({
              key: 'split',
              ...restSplitButtonProps,
              onClick,
              highlighted:
                splitTransaction.highlightedIndex === highlightedIndex,
              embedded,
            });
          })()}
        {createCategory &&
          (() => {
            const createButtonProps = getItemProps
              ? getItemProps({ item: createCategory })
              : {};
            const { onClick, ...restCreateButtonProps } = createButtonProps;
            return (
              <CreateCategoryButton
                key="create-category"
                {...restCreateButtonProps}
                onClick={onClick}
                categoryName={createCategory.name}
                highlighted={
                  createCategory.highlightedIndex === highlightedIndex
                }
                embedded={embedded}
              />
            );
          })()}
        {groupedCategories.map(({ group, categories }) => {
          if (!group) {
            return null;
          }

          return (
            <Fragment key={group.id}>
              {renderCategoryItemGroupHeader({
                title: `${group.name}${group.hidden ? ` ${t('(hidden)')}` : ''}`,
                style: {
                  ...(showHiddenItems &&
                    group.hidden && { color: theme.pageTextSubdued }),
                },
              })}
              {categories.map(item => (
                <Fragment key={item.id}>
                  {renderCategoryItem({
                    ...(getItemProps ? getItemProps({ item }) : {}),
                    item,
                    highlighted: highlightedIndex === item.highlightedIndex,
                    embedded,
                    style: {
                      ...(showHiddenItems &&
                        (item.hidden || group.hidden) && {
                          color: theme.pageTextSubdued,
                        }),
                    },
                    showBalances,
                  })}
                </Fragment>
              ))}
            </Fragment>
          );
        })}
      </View>
      {footer}
    </View>
  );
}

type CategoryAutocompleteProps = ComponentProps<
  typeof Autocomplete<CategoryAutocompleteItem>
> & {
  categoryGroups?: Array<CategoryGroupEntity>;
  showBalances?: boolean;
  showSplitOption?: boolean;
  renderSplitTransactionButton?: (
    props: ComponentPropsWithoutRef<typeof SplitTransactionButton>,
  ) => ReactElement<typeof SplitTransactionButton>;
  renderCategoryItemGroupHeader?: (
    props: ComponentPropsWithoutRef<typeof ItemHeader>,
  ) => ReactElement<typeof ItemHeader>;
  renderCategoryItem?: (
    props: ComponentPropsWithoutRef<typeof CategoryItem>,
  ) => ReactElement<typeof CategoryItem>;
  showHiddenCategories?: boolean;
  // Offer a "Create category" option when the typed name doesn't exist yet
  // (mirrors the payee autocomplete). New categories land in the first
  // expense group.
  showNewCategory?: boolean;
};

export function CategoryAutocomplete({
  categoryGroups,
  showBalances = true,
  showSplitOption,
  embedded,
  closeOnBlur,
  renderSplitTransactionButton,
  renderCategoryItemGroupHeader,
  renderCategoryItem,
  showHiddenCategories,
  showNewCategory,
  ...props
}: CategoryAutocompleteProps) {
  const {
    data: { grouped: defaultCategoryGroups } = { grouped: [] },
    refetch,
  } = useCategories();

  const groupsForCreate = categoryGroups || defaultCategoryGroups;
  const createGroupId = useMemo(() => {
    const expense = groupsForCreate.find(g => !g.is_income && !g.hidden);
    return (
      expense?.id ??
      groupsForCreate.find(g => !g.is_income)?.id ??
      groupsForCreate[0]?.id ??
      null
    );
  }, [groupsForCreate]);
  const canCreate = !!showNewCategory && createGroupId != null;

  // The shared Autocomplete types onSelect as a single|multi union; create is
  // only wired for the single-select register, so cast to the single form.
  const onSelectSingle = props.onSelect as
    | ((id: string, value: string) => void)
    | undefined;

  const handleSelect = async (id: string, rawInputValue: string) => {
    if (id === 'new') {
      const name = rawInputValue.trim();
      if (createGroupId == null || !name) {
        return;
      }
      const newId = (await send('category-create', {
        name,
        groupId: createGroupId,
        isIncome: false,
      })) as string;
      await refetch();
      onSelectSingle?.(newId, rawInputValue);
    } else {
      onSelectSingle?.(id, rawInputValue);
    }
  };

  const filterSuggestions = (
    suggestions: CategoryAutocompleteItem[],
    value: string,
  ) => {
    const filtered = filterCategorySuggestions(suggestions, value);
    if (!canCreate || !value.trim()) {
      return filtered;
    }
    // Don't offer to create a category whose name already exists.
    const exists = suggestions.some(
      s =>
        s.id !== 'split' &&
        s.id !== 'new' &&
        getNormalisedString(s.name) === getNormalisedString(value),
    );
    if (exists) {
      return filtered;
    }
    // Carry the typed name on the item so the button can label itself without
    // a separate renderItems arg (which would pin the single/multi union).
    const newItem = { id: 'new', name: value } as CategoryAutocompleteItem;
    // Keep the split option first (if present), then the create option.
    if (filtered.length > 0 && filtered[0].id === 'split') {
      return [filtered[0], newItem, ...filtered.slice(1)];
    }
    return [newItem, ...filtered];
  };

  const categorySuggestions: CategoryAutocompleteItem[] = useMemo(() => {
    const allSuggestions = (categoryGroups || defaultCategoryGroups).reduce(
      (list, group) =>
        list.concat(
          (group.categories || [])
            .filter(category => category.group === group.id)
            .map(category => ({
              ...category,
              group,
            })),
        ),
      showSplitOption
        ? [{ id: 'split', name: '' } as CategoryAutocompleteItem]
        : [],
    );

    if (!showHiddenCategories) {
      return allSuggestions.filter(
        suggestion =>
          suggestion.id === 'split' ||
          (!suggestion.hidden && !suggestion.group?.hidden),
      );
    }

    return allSuggestions;
  }, [
    categoryGroups,
    defaultCategoryGroups,
    showSplitOption,
    showHiddenCategories,
  ]);

  // Only the single-select register enables create; wrap its onSelect to turn
  // the "new" sentinel into a real category. Cast back to the forwarded props
  // type so the spread stays identical to a plain {...props} (the shared
  // Autocomplete's single|multi prop union only resolves through that spread).
  const passthroughProps = (
    canCreate ? { ...props, onSelect: handleSelect } : props
  ) as unknown as typeof props;

  return (
    <Autocomplete
      strict
      highlightFirst
      embedded={embedded}
      closeOnBlur={closeOnBlur}
      getHighlightedIndex={suggestions => {
        const firstReal = suggestions.findIndex(
          s => s.id !== 'split' && s.id !== 'new',
        );
        if (firstReal !== -1) {
          return firstReal;
        }
        // No real matches: highlight the create option so Enter creates it.
        const newIdx = suggestions.findIndex(s => s.id === 'new');
        return newIdx !== -1 ? newIdx : null;
      }}
      filterSuggestions={filterSuggestions}
      suggestions={categorySuggestions}
      renderItems={(items, getItemProps, highlightedIndex) => (
        <CategoryList
          items={items}
          embedded={embedded}
          getItemProps={getItemProps}
          highlightedIndex={highlightedIndex}
          renderSplitTransactionButton={renderSplitTransactionButton}
          renderCategoryItemGroupHeader={renderCategoryItemGroupHeader}
          renderCategoryItem={renderCategoryItem}
          showHiddenItems={showHiddenCategories}
          showBalances={showBalances}
        />
      )}
      {...passthroughProps}
    />
  );
}

function defaultRenderCategoryItemGroupHeader(
  props: ComponentPropsWithoutRef<typeof ItemHeader>,
): ReactElement<typeof ItemHeader> {
  return <ItemHeader {...props} type="category" />;
}

type SplitTransactionButtonProps = ComponentPropsWithoutRef<typeof View> & {
  Icon?: ComponentType<SVGProps<SVGElement>>;
  highlighted?: boolean;
  embedded?: boolean;
  style?: CSSProperties;
};

function SplitTransactionButton({
  Icon,
  highlighted,
  embedded,
  style,
  ...props
}: SplitTransactionButtonProps) {
  return (
    <View
      // Downshift calls `setTimeout(..., 250)` in the `onMouseMove`
      // event handler they set on this element. When this code runs
      // in WebKit on touch-enabled devices, taps on this element end
      // up not triggering the `onClick` event (and therefore delaying
      // response to user input) until after the `setTimeout` callback
      // finishes executing. This is caused by content observation code
      // that implements various strategies to prevent the user from
      // accidentally clicking content that changed as a result of code
      // run in the `onMouseMove` event.
      //
      // Long story short, we don't want any delay here between the user
      // tapping and the resulting action being performed. It turns out
      // there's some "fast path" logic that can be triggered in various
      // ways to force WebKit to bail on the content observation process.
      // One of those ways is setting `role="button"` (or a number of
      // other aria roles) on the element, which is what we're doing here.
      //
      // ref:
      // * https://github.com/WebKit/WebKit/blob/447d90b0c52b2951a69df78f06bb5e6b10262f4b/LayoutTests/fast/events/touch/ios/content-observation/400ms-hover-intent.html
      // * https://github.com/WebKit/WebKit/blob/58956cf59ba01267644b5e8fe766efa7aa6f0c5c/Source/WebCore/page/ios/ContentChangeObserver.cpp
      // * https://github.com/WebKit/WebKit/blob/58956cf59ba01267644b5e8fe766efa7aa6f0c5c/Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm#L783
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="button"
      style={{
        backgroundColor: highlighted
          ? theme.menuAutoCompleteBackgroundHover
          : 'transparent',
        borderRadius: embedded ? 4 : 0,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        fontSize: 11,
        fontWeight: 500,
        color: theme.noticeTextMenu,
        padding: '6px 8px',
        ':active': {
          backgroundColor: 'rgba(100, 100, 100, .25)',
        },
        ...style,
      }}
      data-testid="split-transaction-button"
      {...props}
    >
      <Text style={{ lineHeight: 0 }}>
        {Icon ? (
          <Icon style={{ marginRight: 5 }} />
        ) : (
          <SvgSplit width={10} height={10} style={{ marginRight: 5 }} />
        )}
      </Text>
      <Trans>Split Transaction</Trans>
    </View>
  );
}

function defaultRenderSplitTransactionButton(
  props: SplitTransactionButtonProps,
): ReactElement<typeof SplitTransactionButton> {
  return <SplitTransactionButton {...props} />;
}

type CreateCategoryButtonProps = ComponentPropsWithoutRef<typeof View> & {
  categoryName: string;
  highlighted?: boolean;
  embedded?: boolean;
  style?: CSSProperties;
};

function CreateCategoryButton({
  categoryName,
  highlighted,
  embedded,
  style,
  ...props
}: CreateCategoryButtonProps) {
  return (
    <View
      // See the comment on SplitTransactionButton for why role="button".
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="button"
      style={{
        backgroundColor: highlighted
          ? theme.menuAutoCompleteBackgroundHover
          : 'transparent',
        borderRadius: embedded ? 4 : 0,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        fontSize: 11,
        fontWeight: 500,
        color: theme.noticeTextMenu,
        padding: '6px 8px',
        ':active': {
          backgroundColor: 'rgba(100, 100, 100, .25)',
        },
        ...style,
      }}
      data-testid="create-category-button"
      {...props}
    >
      <Text style={{ lineHeight: 0 }}>
        <SvgAdd width={8} height={8} style={{ marginRight: 5 }} />
      </Text>
      <Trans>Create category "{categoryName}"</Trans>
    </View>
  );
}

type CategoryItemProps = {
  item: CategoryAutocompleteItem;
  className?: string;
  style?: CSSProperties;
  highlighted?: boolean;
  embedded?: boolean;
  showBalances?: boolean;
};

function CategoryItem({
  item,
  className,
  style,
  highlighted,
  embedded,
  showBalances,
  ...props
}: CategoryItemProps) {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const narrowStyle = isNarrowWidth
    ? {
        ...styles.mobileMenuItem,
        borderRadius: 0,
        borderTop: `1px solid ${theme.pillBorder}`,
      }
    : {};
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');

  const balanceBinding =
    budgetType === 'envelope'
      ? envelopeBudget.catBalance(item.id)
      : trackingBudget.catBalance(item.id);
  const balance = useSheetValue<
    'envelope-budget' | 'tracking-budget',
    typeof balanceBinding
  >(balanceBinding);

  const isToBudgetItem = item.id === 'to-budget';
  const toBudget = useEnvelopeSheetValue(envelopeBudget.toBudget);

  return (
    <button
      type="button"
      style={style}
      // See comment above.
      className={cx(
        className,
        css({
          backgroundColor: highlighted
            ? theme.menuAutoCompleteBackgroundHover
            : 'transparent',
          color: highlighted
            ? theme.menuAutoCompleteItemTextHover
            : theme.menuAutoCompleteItemText,
          padding: 4,
          paddingLeft: 20,
          borderRadius: embedded ? 4 : 0,
          border: 'none',
          font: 'inherit',
          ...narrowStyle,
        }),
      )}
      data-testid={`${item.name}-category-item`}
      data-highlighted={highlighted || undefined}
      {...props}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <TextOneLine>
          {item.name}
          {item.hidden || item.group?.hidden ? ' ' + t('(hidden)') : ''}
        </TextOneLine>
        <TextOneLine
          style={{
            display: !showBalances ? 'none' : undefined,
            marginLeft: 5,
            flexShrink: 0,
            ...makeAmountFullStyle((isToBudgetItem ? toBudget : balance) || 0, {
              positiveColor: theme.noticeTextMenu,
              negativeColor: theme.errorTextMenu,
            }),
          }}
        >
          {isToBudgetItem
            ? toBudget != null && (
                <>
                  {' '}
                  <FinancialText>
                    {integerToCurrency(toBudget || 0)}
                  </FinancialText>
                </>
              )
            : balance != null && (
                <>
                  {' '}
                  <FinancialText>
                    {integerToCurrency(balance || 0)}
                  </FinancialText>
                </>
              )}
        </TextOneLine>
      </View>
    </button>
  );
}

function defaultRenderCategoryItem(
  props: ComponentPropsWithoutRef<typeof CategoryItem>,
): ReactElement<typeof CategoryItem> {
  return <CategoryItem {...props} />;
}
