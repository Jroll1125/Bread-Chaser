import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import type { Modal as ModalType } from '#modals/modalsSlice';

type EmailReceiptsSetupModalProps = Extract<
  ModalType,
  { name: 'email-receipts-setup' }
>['options'];

// The JSON Google hands you when you create a Desktop-app OAuth client looks
// like { "installed": { "client_id": "...", "client_secret": "...", ... } }.
// Pull the two fields out of a pasted blob so the user never has to dig.
function parseGoogleCredentials(
  raw: string,
): { clientId: string; clientSecret: string } | null {
  try {
    const parsed = JSON.parse(raw);
    const node = parsed.installed ?? parsed.web ?? parsed;
    const clientId = node.client_id;
    const clientSecret = node.client_secret;
    if (typeof clientId === 'string' && typeof clientSecret === 'string') {
      return { clientId, clientSecret };
    }
  } catch {
    // Not JSON - the user is typing into the plain fields instead.
  }
  return null;
}

export const EmailReceiptsSetupModal = ({
  onSuccess,
}: EmailReceiptsSetupModalProps) => {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the whole downloaded JSON gets pasted into the Client ID field, split
  // it into both fields automatically.
  const onClientIdChange = (value: string) => {
    const creds = parseGoogleCredentials(value);
    if (creds) {
      setClientId(creds.clientId);
      setClientSecret(creds.clientSecret);
    } else {
      setClientId(value);
    }
    setError(null);
  };

  const onSave = async (close: () => void) => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError(t('Enter both the client ID and client secret.'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await send('email-receipts-configure', {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      onSuccess();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSaving(false);
  };

  return (
    <Modal
      name="email-receipts-setup"
      containerProps={{ style: { width: 500 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Set up Gmail access')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text style={{ lineHeight: 1.5 }}>
              <Trans>
                Create a free Google OAuth client so Bread Chaser can read your
                receipts. This is a one-time setup and everything stays on your
                machine.
              </Trans>
            </Text>
            <View
              style={{
                backgroundColor: theme.tableBackground,
                border: `1px solid ${theme.tableBorder}`,
                borderRadius: 6,
                padding: 12,
                gap: 6,
              }}
            >
              <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                <Trans>1. At console.cloud.google.com, create a project.</Trans>
              </Text>
              <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                <Trans>
                  2. APIs &amp; Services → Library → enable the Gmail API.
                </Trans>
              </Text>
              <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                <Trans>
                  3. OAuth consent screen → External → keep it in Testing → add
                  your Gmail as a test user.
                </Trans>
              </Text>
              <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                <Trans>
                  4. Credentials → Create credentials → OAuth client ID →
                  Application type: Desktop app.
                </Trans>
              </Text>
              <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                <Trans>
                  5. Download the JSON (or copy the client ID and secret) and
                  paste it below.
                </Trans>
              </Text>
            </View>

            <FormField>
              <FormLabel
                title={t('Client ID (or paste the downloaded JSON here):')}
                htmlFor="email-receipts-client-id"
              />
              <InitialFocus>
                <Input
                  id="email-receipts-client-id"
                  value={clientId}
                  onChangeValue={onClientIdChange}
                  placeholder="1234567890-abc.apps.googleusercontent.com"
                />
              </InitialFocus>
            </FormField>

            <FormField>
              <FormLabel
                title={t('Client secret:')}
                htmlFor="email-receipts-client-secret"
              />
              <Input
                id="email-receipts-client-secret"
                type="password"
                value={clientSecret}
                onChangeValue={value => {
                  setClientSecret(value);
                  setError(null);
                }}
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
              <Trans>Save and continue</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
};
