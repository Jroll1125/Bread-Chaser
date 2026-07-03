import React, { useEffect, useState } from 'react';
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

type MortgageSetupModalProps = Extract<
  ModalType,
  { name: 'mortgage-setup' }
>['options'];

function dollars(cents: number): string {
  return cents ? String(cents / 100) : '';
}

export function MortgageSetupModal({ accountId }: MortgageSetupModalProps) {
  const { t } = useTranslation();
  const [rate, setRate] = useState(''); // annual %, e.g. "6.5"
  const [propertyTax, setPropertyTax] = useState(''); // $/month
  const [homeInsurance, setHomeInsurance] = useState('');
  const [pmi, setPmi] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    send('mortgage-get-config', { accountId })
      .then(cfg => {
        if (cfg) {
          setRate(String(Number((cfg.annualInterestRate * 100).toFixed(4))));
          setPropertyTax(dollars(cfg.propertyTaxMonthly));
          setHomeInsurance(dollars(cfg.homeInsuranceMonthly));
          setPmi(dollars(cfg.pmiMonthly));
        }
      })
      .catch(() => {});
  }, [accountId]);

  const onSave = async (close: () => void) => {
    const rateFraction = parseFloat(rate) / 100;
    if (!(rateFraction >= 0 && rateFraction < 1)) {
      setError(t('Enter the annual interest rate, e.g. 6.5'));
      return;
    }
    const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100);
    setIsSaving(true);
    setError(null);
    try {
      await send('mortgage-save-config', {
        accountId,
        annualInterestRate: rateFraction,
        propertyTaxMonthly: toCents(propertyTax),
        homeInsuranceMonthly: toCents(homeInsurance),
        pmiMonthly: toCents(pmi),
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSaving(false);
  };

  return (
    <Modal name="mortgage-setup" containerProps={{ style: { width: 450 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Mortgage terms')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
              <Trans>
                Enter your loan terms. Splitting a payment then uses the current
                balance and rate to work out interest, and these monthly escrow
                amounts for taxes and insurance; the rest is principal.
              </Trans>
            </Text>

            <FormField>
              <FormLabel
                title={t('Annual interest rate (%):')}
                htmlFor="mtg-rate"
              />
              <InitialFocus>
                <Input
                  id="mtg-rate"
                  value={rate}
                  onChangeValue={value => {
                    setRate(value);
                    setError(null);
                  }}
                  placeholder="6.5"
                />
              </InitialFocus>
            </FormField>

            <FormField>
              <FormLabel
                title={t('Property tax ($/month):')}
                htmlFor="mtg-tax"
              />
              <Input
                id="mtg-tax"
                value={propertyTax}
                onChangeValue={setPropertyTax}
                placeholder="500"
              />
            </FormField>

            <FormField>
              <FormLabel
                title={t('Home insurance ($/month):')}
                htmlFor="mtg-ins"
              />
              <Input
                id="mtg-ins"
                value={homeInsurance}
                onChangeValue={setHomeInsurance}
                placeholder="100"
              />
            </FormField>

            <FormField>
              <FormLabel title={t('PMI ($/month):')} htmlFor="mtg-pmi" />
              <Input
                id="mtg-pmi"
                value={pmi}
                onChangeValue={setPmi}
                placeholder="0"
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
              <Trans>Save terms</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
