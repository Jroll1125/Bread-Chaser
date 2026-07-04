import React, { useCallback, useMemo, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { getScheduledAmount } from '@actual-app/core/shared/schedules';
import type { ScheduleEntity } from '@actual-app/core/types/models';

import { Search } from '#components/common/Search';
import { FeatureErrorFallback } from '#components/FeatureErrorFallback';
import { Page } from '#components/Page';
import { usePayees } from '#hooks/usePayees';
import { useSchedules } from '#hooks/useSchedules';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { PaycheckYtdPanel } from './PaycheckYtdPanel';
import { SchedulesTable } from './SchedulesTable';
import type { ScheduleItemAction } from './SchedulesTable';

type ScheduleTab = 'income' | 'expenses';

// A schedule is income-side if it's a transfer (the payee points at another
// account) or its scheduled amount is positive; everything else is a bill.
function isIncomeSchedule(
  schedule: ScheduleEntity,
  transferPayeeIds: Set<string>,
): boolean {
  if (schedule._payee && transferPayeeIds.has(schedule._payee)) {
    return true;
  }
  return getScheduledAmount(schedule._amount) > 0;
}

export function Schedules() {
  const { t } = useTranslation();

  const dispatch = useDispatch();
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<ScheduleTab>('income');
  const { data: payees = [] } = usePayees();

  const onEdit = useCallback(
    (id: ScheduleEntity['id']) => {
      dispatch(
        pushModal({ modal: { name: 'schedule-edit', options: { id } } }),
      );
    },
    [dispatch],
  );

  const onAdd = useCallback(() => {
    dispatch(pushModal({ modal: { name: 'schedule-edit', options: {} } }));
  }, [dispatch]);

  const onAddPaycheck = useCallback(() => {
    dispatch(pushModal({ modal: { name: 'paycheck', options: {} } }));
  }, [dispatch]);

  const onDiscover = useCallback(() => {
    dispatch(pushModal({ modal: { name: 'schedules-discover' } }));
  }, [dispatch]);

  const onChangeUpcomingLength = useCallback(() => {
    dispatch(pushModal({ modal: { name: 'schedules-upcoming-length' } }));
  }, [dispatch]);

  const onAction = useCallback(
    async (name: ScheduleItemAction, id: ScheduleEntity['id']) => {
      switch (name) {
        case 'post-transaction':
          await send('schedule/post-transaction', { id });
          break;
        case 'post-transaction-today':
          await send('schedule/post-transaction', { id, today: true });
          break;
        case 'skip':
          await send('schedule/skip-next-date', { id });
          break;
        case 'complete':
          await send('schedule/update', {
            schedule: { id, completed: true },
          });
          break;
        case 'restart':
          await send('schedule/update', {
            schedule: { id, completed: false },
            resetNextDate: true,
          });
          break;
        case 'delete':
          await send('schedule/delete', { id });
          break;
        default:
          throw new Error(`Unknown action: ${String(name)}`);
      }
    },
    [],
  );

  const schedulesQuery = useMemo(() => q('schedules').select('*'), []);
  const {
    isLoading: isSchedulesLoading,
    schedules,
    statuses,
  } = useSchedules({ query: schedulesQuery });

  const transferPayeeIds = useMemo(
    () =>
      new Set(
        payees.filter(p => p.transfer_acct != null).map(p => p.id),
      ),
    [payees],
  );

  const { incomeSchedules, expenseSchedules } = useMemo(() => {
    const income: ScheduleEntity[] = [];
    const expenses: ScheduleEntity[] = [];
    for (const schedule of schedules) {
      if (isIncomeSchedule(schedule, transferPayeeIds)) {
        income.push(schedule);
      } else {
        expenses.push(schedule);
      }
    }
    return { incomeSchedules: income, expenseSchedules: expenses };
  }, [schedules, transferPayeeIds]);

  const shownSchedules = tab === 'income' ? incomeSchedules : expenseSchedules;

  const tabButton = (key: ScheduleTab, label: string, count: number) => (
    <Button
      variant="bare"
      onPress={() => setTab(key)}
      style={{
        borderRadius: 0,
        borderBottom:
          '2px solid ' +
          (tab === key ? theme.pageTextPositive : 'transparent'),
        padding: '6px 4px',
        fontWeight: tab === key ? 600 : 'normal',
        color: tab === key ? theme.pageText : theme.pageTextSubdued,
      }}
    >
      {label}
      <Text style={{ marginLeft: 6, color: theme.pageTextSubdued }}>
        {count}
      </Text>
    </Button>
  );

  return (
    <ErrorBoundary FallbackComponent={FeatureErrorFallback}>
      <Page header={t('Bills & Income')}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            padding: '0 0 15px',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: '1.5em',
              borderBottom: '1px solid ' + theme.tableBorder,
            }}
          >
            {tabButton(
              'income',
              t('Income & Transfers'),
              incomeSchedules.length,
            )}
            {tabButton('expenses', t('Expenses'), expenseSchedules.length)}
          </View>
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              justifyContent: 'flex-end',
            }}
          >
            <Search
              placeholder={t('Filter…')}
              value={filter}
              onChange={setFilter}
            />
          </View>
        </View>

        {tab === 'income' && <PaycheckYtdPanel />}

        <SchedulesTable
          isLoading={isSchedulesLoading}
          schedules={shownSchedules}
          filter={filter}
          statuses={statuses}
          allowCompleted
          onSelect={onEdit}
          onAction={onAction}
          style={{ backgroundColor: theme.tableBackground }}
        />

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            margin: '20px 0',
            flexShrink: 0,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: '1em',
            }}
          >
            <Button onPress={onDiscover}>
              <Trans>Find schedules</Trans>
            </Button>
            <Button onPress={onChangeUpcomingLength}>
              <Trans>Change upcoming length</Trans>
            </Button>
          </View>
          <View style={{ flexDirection: 'row', gap: '1em' }}>
            {tab === 'income' && (
              <Button onPress={onAddPaycheck}>
                <Trans>Paycheck…</Trans>
              </Button>
            )}
            <Button variant="primary" onPress={onAdd}>
              <Trans>Add new schedule</Trans>
            </Button>
          </View>
        </View>
      </Page>
    </ErrorBoundary>
  );
}
