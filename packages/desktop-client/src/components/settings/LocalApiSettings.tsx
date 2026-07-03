import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Setting } from './UI';

type Status = { port: number; url: string; hasKey: boolean };

export function LocalApiSettings() {
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
    <Setting
      primaryAction={
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <ButtonWithLoading
            variant="primary"
            isLoading={busy}
            onPress={() => void onGenerate()}
          >
            {on ? (
              <Trans>Regenerate key</Trans>
            ) : (
              <Trans>Generate API key</Trans>
            )}
          </ButtonWithLoading>
          {on && (
            <Button onPress={() => void onRevoke()}>
              <Trans>Revoke</Trans>
            </Button>
          )}
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>Local API</strong> is a localhost REST endpoint for scripts and
          tools to read and bulk-edit your transactions. It stays off until you
          generate a key, and is reachable only from this computer.
        </Trans>
      </Text>

      {on && (
        <View style={{ gap: 6, width: '100%' }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
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
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              <Trans>API key</Trans>
            </Text>
            <Text style={mono}>
              {key
                ? revealed
                  ? key
                  : `${key.slice(0, 6)}${'•'.repeat(16)}`
                : '—'}
            </Text>
            <Button onPress={() => setRevealed(v => !v)}>
              {revealed ? <Trans>Hide</Trans> : <Trans>Reveal</Trans>}
            </Button>
            {key && (
              <Button onPress={() => copy(key)}>
                <Trans>Copy</Trans>
              </Button>
            )}
          </View>
          <Text style={{ color: theme.pageTextSubdued, fontSize: 11 }}>
            <Trans>
              Send it as an Authorization: Bearer header. Try GET {{ url }}
              /health.
            </Trans>
          </Text>
        </View>
      )}

      {message && (
        <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
          {message}
        </Text>
      )}
    </Setting>
  );
}
