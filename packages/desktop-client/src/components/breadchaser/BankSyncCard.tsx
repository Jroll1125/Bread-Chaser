import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { PlaidStatus } from '@actual-app/core/types/models';

import { useAccounts } from '#hooks/useAccounts';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

function EnvBadge({ status }: { status: PlaidStatus | null }) {
  const { t } = useTranslation();

  let label = t('Not configured');
  if (status?.configured) {
    label = status.env === 'production' ? t('Production') : t('Sandbox');
  }

  return (
    <Text
      style={{
        backgroundColor:
          status?.env === 'production'
            ? theme.noticeBackground
            : theme.pillBackground,
        color:
          status?.env === 'production' ? theme.noticeText : theme.pillText,
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {label}
    </Text>
  );
}

export function BankSyncCard() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const accountsQuery = useAccounts();
  const [status, setStatus] = useState<PlaidStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSandboxLinking, setIsSandboxLinking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    send('plaid-status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const plaidAccounts = (accountsQuery.data ?? []).filter(
    account => account.account_sync_source === 'plaid' && !account.closed,
  );

  const onConnect = () => {
    dispatch(
      pushModal({
        modal: {
          name: 'plaid-link',
          options: {
            onSuccess: () => {
              void accountsQuery.refetch();
            },
          },
        },
      }),
    );
  };

  const onSandboxConnect = async () => {
    setIsSandboxLinking(true);
    setMessage(null);
    try {
      const { createdAccountIds } = await send('plaid-sandbox-link', {});
      setMessage(
        t('Connected {{count}} sandbox account(s).', {
          count: createdAccountIds.length,
        }),
      );
      void accountsQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    setIsSandboxLinking(false);
  };

  const onSyncNow = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const res = await send('accounts-bank-sync', {
        ids: plaidAccounts.map(account => account.id),
      });
      if (res.errors.length > 0) {
        setMessage(res.errors.map(error => error.message).join(' '));
      } else {
        setMessage(
          t('Synced. {{count}} new transaction(s).', {
            count: res.newTransactions.length,
          }),
        );
      }
      void accountsQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    setIsSyncing(false);
  };

  return (
    <View
      style={{
        backgroundColor: theme.cardBackground,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        padding: 15,
        gap: 10,
        flexGrow: 1,
        flexBasis: 250,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: 600, color: theme.pageText }}>
          <Trans>Bank sync</Trans>
        </Text>
        <EnvBadge status={status} />
      </View>

      {plaidAccounts.length === 0 ? (
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            No banks connected yet. Transactions and balances import
            automatically once you connect one.
          </Trans>
        </Text>
      ) : (
        <View style={{ gap: 5 }}>
          {plaidAccounts.map(account => (
            <View
              key={account.id}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <Text style={{ color: theme.pageText }}>{account.name}</Text>
              <Text style={{ color: theme.pageTextSubdued, flexShrink: 0 }}>
                {account.bank_sync_status && account.bank_sync_status !== 'ok'
                  ? account.bank_sync_status
                  : account.last_sync
                    ? new Date(Number(account.last_sync)).toLocaleString()
                    : t('Never synced')}
              </Text>
            </View>
          ))}
        </View>
      )}

      {message && (
        <Text style={{ color: theme.pageTextSubdued }}>{message}</Text>
      )}

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" onPress={onConnect}>
          <Trans>Connect a bank</Trans>
        </Button>
        {plaidAccounts.length > 0 && (
          <ButtonWithLoading
            isLoading={isSyncing}
            onPress={() => {
              void onSyncNow();
            }}
          >
            <Trans>Sync now</Trans>
          </ButtonWithLoading>
        )}
        {status?.configured && status.env === 'sandbox' && (
          <ButtonWithLoading
            isLoading={isSandboxLinking}
            onPress={() => {
              void onSandboxConnect();
            }}
          >
            <Trans>Connect sandbox bank</Trans>
          </ButtonWithLoading>
        )}
      </View>
    </View>
  );
}
