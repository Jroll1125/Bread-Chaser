import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { AccountType } from '@actual-app/core/types/models';
import { useQueryClient } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { Error as ErrorAlert } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import { useAccount } from '#hooks/useAccount';
import type { Modal as ModalType } from '#modals/modalsSlice';

type AccountTypeModalProps = Extract<
  ModalType,
  { name: 'account-type' }
>['options'];

export function AccountTypeModal({ accountId }: AccountTypeModalProps) {
  const { t } = useTranslation();
  const account = useAccount(accountId);
  const queryClient = useQueryClient();

  const [type, setType] = useState<AccountType>(account?.type ?? 'other');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync the initial value once the account query resolves.
  useEffect(() => {
    if (account?.type) {
      setType(account.type);
    }
  }, [account?.type]);

  const options: Array<[AccountType, string]> = [
    ['checking', t('Checking')],
    ['savings', t('Savings')],
    ['credit-card', t('Credit card')],
    ['cash', t('Cash')],
    ['investment', t('Investment')],
    ['mortgage', t('Mortgage')],
    ['loan', t('Loan')],
    ['other', t('Other')],
  ];

  const onSave = async (close: () => void) => {
    setIsSaving(true);
    setError(null);
    try {
      await send('account-update', { id: accountId, type });
      await queryClient.invalidateQueries({ queryKey: accountQueries.all() });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSaving(false);
  };

  return (
    <Modal name="account-type" containerProps={{ style: { width: 400 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Account type')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
              <Trans>
                Set what kind of account {{ name: account?.name ?? '' }} is.
                Choosing “Mortgage” unlocks the mortgage-payment tools.
              </Trans>
            </Text>

            <FormField>
              <FormLabel title={t('Type:')} htmlFor="account-type-select" />
              <Select<AccountType>
                id="account-type-select"
                value={type}
                onChange={value => {
                  setType(value);
                  setError(null);
                }}
                options={options}
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
}
