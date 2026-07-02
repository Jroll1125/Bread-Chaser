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

type PlaidLinkModalProps = Extract<
  ModalType,
  { name: 'plaid-link' }
>['options'];

export const PlaidLinkModal = ({ onSuccess }: PlaidLinkModalProps) => {
  const { t } = useTranslation();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAccountIds, setCreatedAccountIds] = useState<string[] | null>(
    null,
  );

  const startLink = async () => {
    setIsStarting(true);
    setError(null);
    try {
      const { linkToken: newToken, url } = await send(
        'plaid-create-link-token',
      );
      window.Actual.openURLInBrowser(url);
      setLinkToken(newToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsStarting(false);
  };

  useEffect(() => {
    if (!linkToken || createdAccountIds) {
      return;
    }

    let cancelled = false;
    const intervalId = setInterval(async () => {
      try {
        const res = await send('plaid-poll-link', { linkToken });
        if (!cancelled && res.status === 'completed') {
          setCreatedAccountIds(res.createdAccountIds);
          onSuccess(res.createdAccountIds);
        }
      } catch {
        // Transient poll failures are fine - the next tick retries, and the
        // user can always cancel.
      }
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [linkToken, createdAccountIds, onSuccess]);

  return (
    <Modal name="plaid-link" containerProps={{ style: { width: '30vw' } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Connect a bank via Plaid')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            {createdAccountIds ? (
              <Text>
                <Trans count={createdAccountIds.length}>
                  Connected {{ count: createdAccountIds.length }} account(s).
                  Their transactions are importing now.
                </Trans>
              </Text>
            ) : linkToken ? (
              <Text>
                <Trans>
                  Finish connecting your bank in the browser window that just
                  opened. This screen updates automatically when you are done.
                </Trans>
              </Text>
            ) : (
              <Text>
                <Trans>
                  Bank sign-in happens in your regular browser (banks like
                  Chase require it), then Bread Chaser picks it up from here.
                </Trans>
              </Text>
            )}

            {error && <ErrorAlert>{error}</ErrorAlert>}
          </View>

          <ModalButtons>
            {createdAccountIds ? (
              <ButtonWithLoading
                variant="primary"
                onPress={() => state.close()}
              >
                <Trans>Done</Trans>
              </ButtonWithLoading>
            ) : (
              <ButtonWithLoading
                variant="primary"
                isLoading={isStarting || linkToken != null}
                onPress={() => {
                  void startLink();
                }}
              >
                <Trans>Open bank sign-in</Trans>
              </ButtonWithLoading>
            )}
          </ModalButtons>
        </>
      )}
    </Modal>
  );
};
