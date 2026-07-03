import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

type Status = { port: number; url: string; hasKey: boolean };

function Badge({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <Text
      style={{
        backgroundColor: on ? theme.noticeBackground : theme.pillBackground,
        color: on ? theme.noticeText : theme.pillText,
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {on ? t('On') : t('Off')}
    </Text>
  );
}

export function LocalApiCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    send('local-api-status')
      .then(setStatus)
      .catch(() => setStatus(null));
    send('local-api-get-key')
      .then(r => setKey(r.key))
      .catch(() => setKey(null));
  };
  useEffect(refresh, []);

  const onGenerate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { key: generated } = await send('local-api-generate-key');
      setKey(generated);
      setRevealed(true);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
    refresh();
  };

  const onRevoke = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await send('local-api-revoke-key');
      setKey(null);
      setRevealed(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
    refresh();
  };

  const copy = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setMessage(t('Copied to clipboard.')))
      .catch(() => {});
  };

  const on = !!status?.hasKey;
  const url = status?.url ?? 'http://localhost:5008';

  const mono = {
    fontFamily: 'monospace',
    fontSize: 12,
    backgroundColor: theme.pillBackground,
    color: theme.pillText,
    borderRadius: 4,
    padding: '3px 6px',
    wordBreak: 'break-all',
  } as const;

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
          <Trans>Local API</Trans>
        </Text>
        <Badge on={on} />
      </View>

      <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
        <Trans>
          A localhost REST API for scripts and tools to read and bulk-edit your
          transactions. Generate a key to turn it on.
        </Trans>
      </Text>

      {on && (
        <View style={{ gap: 6 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              <Trans>Endpoint</Trans>
            </Text>
            <Text style={mono}>{url}</Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              <Trans>API key</Trans>
            </Text>
            <Text style={{ ...mono, flexShrink: 1 }}>
              {key
                ? revealed
                  ? key
                  : `${key.slice(0, 6)}${'•'.repeat(16)}`
                : '—'}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button onPress={() => setRevealed(v => !v)}>
              {revealed ? <Trans>Hide</Trans> : <Trans>Reveal</Trans>}
            </Button>
            {key && (
              <Button onPress={() => copy(key)}>
                <Trans>Copy key</Trans>
              </Button>
            )}
          </View>
          <Text
            style={{ color: theme.pageTextSubdued, fontSize: 11, marginTop: 4 }}
          >
            <Trans>
              Send it as an Authorization: Bearer header. Try GET {{url}}/health.
            </Trans>
          </Text>
        </View>
      )}

      {message && (
        <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
          {message}
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <ButtonWithLoading
          variant="primary"
          isLoading={busy}
          onPress={() => void onGenerate()}
        >
          {on ? <Trans>Regenerate key</Trans> : <Trans>Generate API key</Trans>}
        </ButtonWithLoading>
        {on && (
          <Button onPress={() => void onRevoke()}>
            <Trans>Revoke</Trans>
          </Button>
        )}
      </View>
    </View>
  );
}
