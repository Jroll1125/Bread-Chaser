import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { PlaidEnv } from '@actual-app/core/types/models';

import { Error as ErrorAlert } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import type { Modal as ModalType } from '#modals/modalsSlice';

type PlaidSetupModalProps = Extract<
  ModalType,
  { name: 'plaid-setup' }
>['options'];

// Plaid's dashboard shows client_id + a per-environment secret. If the user
// pastes a JSON blob with those fields, pull them out; otherwise they type
// into the plain inputs.
function parsePlaidCredentials(
  raw: string,
): { clientId: string; secret: string } | null {
  try {
    const parsed = JSON.parse(raw);
    const clientId = parsed.client_id ?? parsed.clientId;
    const secret = parsed.secret ?? parsed.client_secret;
    if (typeof clientId === 'string' && typeof secret === 'string') {
      return { clientId, secret };
    }
  } catch {
    // Not JSON - the user is typing into the plain fields instead.
  }
  return null;
}

export const PlaidSetupModal = ({ onSuccess }: PlaidSetupModalProps) => {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState<PlaidEnv>('sandbox');
  const [alreadyConfigured, setAlreadyConfigured] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the client id + environment from the current config so changing
  // one of them doesn't mean re-typing everything (the secret never leaves the
  // keychain, so it stays blank).
  useEffect(() => {
    send('plaid-status')
      .then(status => {
        if (status.clientId) {
          setClientId(status.clientId);
        }
        if (status.env) {
          setEnv(status.env);
        }
        setAlreadyConfigured(status.configured);
      })
      .catch(() => {});
  }, []);

  const onClientIdChange = (value: string) => {
    const creds = parsePlaidCredentials(value);
    if (creds) {
      setClientId(creds.clientId);
      setSecret(creds.secret);
    } else {
      setClientId(value);
    }
    setError(null);
  };

  const onSave = async (close: () => void) => {
    if (!clientId.trim()) {
      setError(t('Enter your Plaid client ID.'));
      return;
    }
    if (!secret.trim() && !alreadyConfigured) {
      setError(t('Enter your Plaid secret.'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await send('plaid-configure', {
        clientId: clientId.trim(),
        secret: secret.trim() || undefined,
        env,
      });
      onSuccess();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSaving(false);
  };

  return (
    <Modal name="plaid-setup" containerProps={{ style: { width: 500 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Set up Plaid')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text style={{ lineHeight: 1.5 }}>
              <Trans>
                Enter your Plaid API keys so Bread Chaser can connect your
                banks. Find them in the Plaid dashboard under Developers → Keys.
                The secret is stored in your OS keychain, never in a plain file.
              </Trans>
            </Text>

            <FormField>
              <FormLabel title={t('Environment:')} htmlFor="plaid-env" />
              <Select<PlaidEnv>
                id="plaid-env"
                value={env}
                onChange={value => {
                  setEnv(value);
                  setError(null);
                }}
                options={[
                  ['sandbox', t('Sandbox (test data)')],
                  ['production', t('Production (real banks)')],
                ]}
              />
            </FormField>

            <FormField>
              <FormLabel
                title={t('Client ID (or paste your Plaid keys JSON here):')}
                htmlFor="plaid-client-id"
              />
              <InitialFocus>
                <Input
                  id="plaid-client-id"
                  value={clientId}
                  onChangeValue={onClientIdChange}
                  placeholder="5f9a1b2c3d4e5f6a7b8c9d0e"
                />
              </InitialFocus>
            </FormField>

            <FormField>
              <FormLabel title={t('Secret:')} htmlFor="plaid-secret" />
              <Input
                id="plaid-secret"
                type="password"
                value={secret}
                onChangeValue={value => {
                  setSecret(value);
                  setError(null);
                }}
                placeholder={
                  alreadyConfigured
                    ? t('Leave blank to keep the current secret')
                    : undefined
                }
              />
            </FormField>

            {error && <ErrorAlert>{error}</ErrorAlert>}
          </View>

          <ModalButtons>
            <ButtonWithLoading
              variant="primary"
              isLoading={isSaving}
              onPress={() => {
                void onSave(() => state.close());
              }}
            >
              <Trans>Save</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
};
