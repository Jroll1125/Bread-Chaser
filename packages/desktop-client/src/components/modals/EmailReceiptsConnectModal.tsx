import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import type { Modal as ModalType } from '#modals/modalsSlice';

type EmailReceiptsConnectModalProps = Extract<
  ModalType,
  { name: 'email-receipts-connect' }
>['options'];

export const EmailReceiptsConnectModal = ({
  onSuccess,
}: EmailReceiptsConnectModalProps) => {
  const { t } = useTranslation();
  const [isPolling, setIsPolling] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);

  const startConnect = async () => {
    setIsStarting(true);
    setError(null);
    try {
      const { url } = await send('email-receipts-connect');
      window.Actual.openURLInBrowser(url);
      setIsPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsStarting(false);
  };

  useEffect(() => {
    if (!isPolling || connectedEmail) {
      return;
    }

    let cancelled = false;
    // The token exchange + profile fetch happen inside the poll handler once
    // Google redirects; the in-flight guard keeps interval ticks from
    // stacking concurrent exchanges (same pattern as PlaidLinkModal).
    let inFlight = false;
    const intervalId = setInterval(async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const res = await send('email-receipts-poll-connect');
        if (cancelled) {
          return;
        }
        if (res.status === 'completed') {
          setConnectedEmail(res.email);
          setIsPolling(false);
          onSuccess(res.email);
        } else if (res.status === 'error') {
          setError(res.message);
          setIsPolling(false);
        }
      } catch {
        // Transient poll failures are fine - the next tick retries, and the
        // user can always cancel.
      } finally {
        inFlight = false;
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isPolling, connectedEmail, onSuccess]);

  return (
    <Modal
      name="email-receipts-connect"
      containerProps={{ style: { width: '30vw' } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Connect Gmail')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            {connectedEmail ? (
              <Text>
                <Trans>
                  Connected {{ email: connectedEmail }}. Use Sync now on the
                  Email Receipts card to pull your receipts.
                </Trans>
              </Text>
            ) : isPolling ? (
              <Text>
                <Trans>
                  Finish signing in with Google in the browser window that
                  just opened. This screen updates automatically when you are
                  done.
                </Trans>
              </Text>
            ) : (
              <Text>
                <Trans>
                  Google sign-in happens in your regular browser with
                  read-only access to your mail. Receipt contents are
                  processed by a local model and never leave this machine.
                </Trans>
              </Text>
            )}

            {error && <ErrorAlert>{error}</ErrorAlert>}
          </View>

          <ModalButtons>
            {connectedEmail ? (
              <ButtonWithLoading
                variant="primary"
                onPress={() => state.close()}
              >
                <Trans>Done</Trans>
              </ButtonWithLoading>
            ) : (
              <ButtonWithLoading
                variant="primary"
                isLoading={isStarting || isPolling}
                onPress={() => {
                  void startConnect();
                }}
              >
                <Trans>Open Google sign-in</Trans>
              </ButtonWithLoading>
            )}
          </ModalButtons>
        </>
      )}
    </Modal>
  );
};
