import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { Toggle } from '@actual-app/components/toggle';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { EmailReceiptsStatus } from '@actual-app/core/types/models';

import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

function LlmBadge({ status }: { status: EmailReceiptsStatus | null }) {
  const { t } = useTranslation();

  const connected = status?.llm.connected === true;
  return (
    <Text
      style={{
        backgroundColor: connected
          ? theme.noticeBackground
          : theme.pillBackground,
        color: connected ? theme.noticeText : theme.pillText,
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {connected ? t('Local model: connected') : t('Local model: offline')}
    </Text>
  );
}

export function EmailReceiptsCard() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [status, setStatus] = useState<EmailReceiptsStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshStatus = () => {
    send('email-receipts-status')
      .then(setStatus)
      .catch(() => setStatus(null));
  };

  useEffect(refreshStatus, []);

  const onSetUp = () => {
    dispatch(
      pushModal({
        modal: {
          name: 'email-receipts-setup',
          options: {
            onSuccess: () => {
              refreshStatus();
            },
          },
        },
      }),
    );
  };

  const onConnect = () => {
    dispatch(
      pushModal({
        modal: {
          name: 'email-receipts-connect',
          options: {
            onSuccess: () => {
              refreshStatus();
            },
          },
        },
      }),
    );
  };

  const onReview = () => {
    dispatch(
      pushModal({
        modal: {
          name: 'email-receipts-review',
          options: {
            onChange: () => {
              refreshStatus();
            },
          },
        },
      }),
    );
  };

  const onToggleAutoApply = async (autoApply: boolean) => {
    // Optimistic: flip immediately so the toggle doesn't feel laggy, then
    // reconcile with the server (which is the source of truth on refresh).
    setStatus(prev => (prev ? { ...prev, autoApply } : prev));
    try {
      await send('email-receipts-set-auto-apply', { autoApply });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    refreshStatus();
  };

  const onSyncNow = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const res = await send('email-receipts-sync');
      const parts = [
        t('{{count}} receipt(s) extracted.', { count: res.extracted }),
        t('{{count}} auto-applied.', { count: res.autoApplied }),
        t('{{count}} queued for review.', { count: res.queuedForReview }),
      ];
      if (res.llmUnavailable) {
        parts.push(
          t('Local model offline; extraction retries on the next sync.'),
        );
      }
      setMessage(parts.join(' '));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    setIsSyncing(false);
    refreshStatus();
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
          <Trans>Email receipts</Trans>
        </Text>
        <LlmBadge status={status} />
      </View>

      {!status?.available ? (
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Receipts from your Gmail get matched to imported transactions.
            Available in the desktop app.
          </Trans>
        </Text>
      ) : !status.configured ? (
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Set up a one-time Google connection, then your receipts get
            extracted by a local model and matched to your transactions.
          </Trans>
        </Text>
      ) : !status.connected && !status.needsReconnect ? (
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Connect your Gmail (read-only) and receipts get extracted by a
            local model on this machine, then matched to your transactions.
          </Trans>
        </Text>
      ) : (
        <View style={{ gap: 5 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <Text style={{ color: theme.pageText }}>{status.email}</Text>
            {status.needsReconnect && (
              <Text style={{ color: theme.errorText, flexShrink: 0 }}>
                <Trans>Authorization expired</Trans>
              </Text>
            )}
          </View>
          <Text style={{ color: theme.pageTextSubdued }}>
            {status.lastSync
              ? t('Last sync: {{when}}', {
                  when: new Date(status.lastSync).toLocaleString(),
                })
              : t('Never synced')}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              paddingTop: 4,
            }}
          >
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>Auto-apply exact matches</Trans>
            </Text>
            <Toggle
              id="email-receipts-auto-apply"
              isOn={status.autoApply}
              onToggle={value => {
                void onToggleAutoApply(value);
              }}
            />
          </View>
          {!status.autoApply && (
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              <Trans>
                Off - every match waits in Review, even exact ones.
              </Trans>
            </Text>
          )}
        </View>
      )}

      {message && (
        <Text style={{ color: theme.pageTextSubdued }}>{message}</Text>
      )}

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        {status?.available && !status.configured && (
          <Button variant="primary" onPress={onSetUp}>
            <Trans>Set up Gmail</Trans>
          </Button>
        )}
        {status?.available && status.configured && !status.connected && (
          <Button variant="primary" onPress={onConnect}>
            {status.needsReconnect ? (
              <Trans>Reconnect Gmail</Trans>
            ) : (
              <Trans>Connect Gmail</Trans>
            )}
          </Button>
        )}
        {status?.available && status.configured && (
          <Button onPress={onSetUp}>
            <Trans>Edit credentials</Trans>
          </Button>
        )}
        {status?.connected && (
          <ButtonWithLoading
            variant="primary"
            isLoading={isSyncing}
            onPress={() => {
              void onSyncNow();
            }}
          >
            <Trans>Sync now</Trans>
          </ButtonWithLoading>
        )}
        {status?.available && status.pendingReview > 0 && (
          <Button onPress={onReview}>
            {t('Review ({{count}})', { count: status.pendingReview })}
          </Button>
        )}
        {status?.connected && status.pendingReview === 0 && (
          <Button onPress={onReview}>
            <Trans>Applied log</Trans>
          </Button>
        )}
      </View>
    </View>
  );
}
