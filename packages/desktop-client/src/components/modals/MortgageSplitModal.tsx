import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
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
import { useAccounts } from '#hooks/useAccounts';
import { pushModal } from '#modals/modalsSlice';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

type MortgageSplitModalProps = Extract<
  ModalType,
  { name: 'mortgage-split' }
>['options'];

export function MortgageSplitModal({ transactionId }: MortgageSplitModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const accountsQuery = useAccounts();
  const mortgages = (accountsQuery.data ?? []).filter(
    account => account.type === 'mortgage' && !account.closed,
  );

  const [mortgageAccountId, setMortgageAccountId] = useState(
    mortgages[0]?.id ?? '',
  );
  const [isSplitting, setIsSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSplit = async (close: () => void) => {
    if (!mortgageAccountId) {
      setError(t('Pick a mortgage account.'));
      return;
    }
    setIsSplitting(true);
    setError(null);
    try {
      await send('mortgage-split-payment', {
        transactionId,
        mortgageAccountId,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSplitting(false);
  };

  return (
    <Modal name="mortgage-split" containerProps={{ style: { width: 450 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Split as mortgage payment')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            {mortgages.length === 0 ? (
              <>
                <Text style={{ lineHeight: 1.5 }}>
                  <Trans>
                    No mortgage account found. Set an account’s type to
                    “Mortgage” (from its menu) and add its loan terms first.
                  </Trans>
                </Text>
                <Button onPress={() => state.close()}>
                  <Trans>Close</Trans>
                </Button>
              </>
            ) : (
              <>
                <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                  <Trans>
                    Break this payment into interest, property tax, home
                    insurance, and PMI, with the rest paid to the mortgage as
                    principal.
                  </Trans>
                </Text>

                <FormField>
                  <FormLabel
                    title={t('Mortgage account:')}
                    htmlFor="mtg-split-account"
                  />
                  <Select
                    id="mtg-split-account"
                    value={mortgageAccountId}
                    onChange={value => {
                      setMortgageAccountId(value);
                      setError(null);
                    }}
                    options={mortgages.map(account => [account.id, account.name])}
                  />
                </FormField>

                {error && (
                  <>
                    <ErrorAlert>{error}</ErrorAlert>
                    <Button
                      onPress={() => {
                        dispatch(
                          pushModal({
                            modal: {
                              name: 'mortgage-setup',
                              options: { accountId: mortgageAccountId },
                            },
                          }),
                        );
                      }}
                    >
                      <Trans>Set up loan terms</Trans>
                    </Button>
                  </>
                )}
              </>
            )}
          </View>

          {mortgages.length > 0 && (
            <ModalButtons>
              <ButtonWithLoading
                variant="primary"
                isLoading={isSplitting}
                onPress={() => {
                  void onSplit(() => state.close());
                }}
              >
                <Trans>Split payment</Trans>
              </ButtonWithLoading>
            </ModalButtons>
          )}
        </>
      )}
    </Modal>
  );
}
