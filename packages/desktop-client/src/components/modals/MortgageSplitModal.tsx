import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
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

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

function toCents(v: string): number {
  return Math.round((parseFloat(v) || 0) * 100);
}

function fromCents(cents: number): string {
  return String(cents / 100);
}

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
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentDate, setPaymentDate] = useState('');
  const [interest, setInterest] = useState('');
  const [tax, setTax] = useState('');
  const [insurance, setInsurance] = useState('');
  const [pmi, setPmi] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [isSplitting, setIsSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mortgageAccountId) {
      return;
    }
    setError(null);
    setNeedsSetup(false);
    send('mortgage-preview-split', { transactionId, mortgageAccountId })
      .then(preview => {
        setPaymentAmount(preview.paymentAmount);
        setPaymentDate(preview.date);
        setInterest(fromCents(preview.interest));
        setTax(fromCents(preview.propertyTax));
        setInsurance(fromCents(preview.homeInsurance));
        setPmi(fromCents(preview.pmi));
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        if (/set up the mortgage terms/i.test(message)) {
          setNeedsSetup(true);
        }
      });
  }, [transactionId, mortgageAccountId]);

  const escrowAndInterest =
    toCents(interest) + toCents(tax) + toCents(insurance) + toCents(pmi);
  const principalCents = paymentAmount - escrowAndInterest;
  const principalValid = principalCents > 0;

  const onSplit = async (close: () => void) => {
    if (!mortgageAccountId) {
      setError(t('Pick a mortgage account.'));
      return;
    }
    if (!principalValid) {
      setError(
        t('Interest and escrow add up to more than the payment — adjust them.'),
      );
      return;
    }
    setIsSplitting(true);
    setError(null);
    try {
      await send('mortgage-split-payment', {
        transactionId,
        mortgageAccountId,
        overrides: {
          interest: toCents(interest),
          propertyTax: toCents(tax),
          homeInsurance: toCents(insurance),
          pmi: toCents(pmi),
        },
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSplitting(false);
  };

  const line = (
    label: string,
    id: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <Text style={{ color: theme.pageText }}>{label}</Text>
      <Input
        id={id}
        value={value}
        onChangeValue={v => {
          onChange(v);
          setError(null);
        }}
        style={{ width: 120, textAlign: 'right' }}
      />
    </View>
  );

  return (
    <Modal name="mortgage-split" containerProps={{ style: { width: 460 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Split as mortgage payment')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 12 }}>
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
                    These are prefilled from your terms and the escrow in force
                    on the payment date — edit any line to match your statement.
                    Principal fills the rest.
                  </Trans>
                </Text>

                {mortgages.length > 1 && (
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
                      options={mortgages.map(account => [
                        account.id,
                        account.name,
                      ])}
                    />
                  </FormField>
                )}

                {needsSetup ? (
                  <>
                    {error && <ErrorAlert>{error}</ErrorAlert>}
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
                ) : (
                  <>
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        paddingBottom: 8,
                        borderBottom: '1px solid ' + theme.tableBorder,
                      }}
                    >
                      <Text style={{ color: theme.pageTextSubdued }}>
                        <Trans>Payment on {{ date: paymentDate }}</Trans>
                      </Text>
                      <Text style={{ fontWeight: 500 }}>
                        {money(paymentAmount)}
                      </Text>
                    </View>

                    {line(t('Interest'), 'mtg-interest', interest, setInterest)}
                    {line(t('Property tax'), 'mtg-tax', tax, setTax)}
                    {line(
                      t('Home insurance'),
                      'mtg-ins',
                      insurance,
                      setInsurance,
                    )}
                    {line(t('PMI'), 'mtg-pmi', pmi, setPmi)}

                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        paddingTop: 8,
                        borderTop: '1px solid ' + theme.tableBorder,
                      }}
                    >
                      <Text style={{ fontWeight: 500 }}>
                        <Trans>Principal (to loan)</Trans>
                      </Text>
                      <Text
                        style={{
                          fontWeight: 500,
                          color: principalValid
                            ? theme.noticeText
                            : theme.errorText,
                        }}
                      >
                        {money(principalCents)}
                      </Text>
                    </View>

                    {error && <ErrorAlert>{error}</ErrorAlert>}
                  </>
                )}
              </>
            )}
          </View>

          {mortgages.length > 0 && !needsSetup && (
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
