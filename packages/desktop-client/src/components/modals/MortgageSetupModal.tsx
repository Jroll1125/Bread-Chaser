import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { computePayment } from '@actual-app/core/shared/mortgage';

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

function dollars(cents: number | null): string {
  return cents ? String(cents / 100) : '';
}

function toCents(v: string): number {
  return Math.round((parseFloat(v) || 0) * 100);
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export function MortgageSetupModal({ accountId }: MortgageSetupModalProps) {
  const { t } = useTranslation();
  const [rate, setRate] = useState(''); // annual %, e.g. "7"
  const [principal, setPrincipal] = useState(''); // original loan, $
  const [startDate, setStartDate] = useState(''); // yyyy-mm-dd
  const [termYears, setTermYears] = useState(''); // e.g. "30"
  const [piPayment, setPiPayment] = useState(''); // monthly P&I, $ (optional)
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    send('mortgage-get-config', { accountId })
      .then(cfg => {
        if (cfg) {
          setRate(String(Number((cfg.annualInterestRate * 100).toFixed(4))));
          setPrincipal(dollars(cfg.originalPrincipal));
          setStartDate(cfg.startDate ?? '');
          setTermYears(cfg.termMonths ? String(cfg.termMonths / 12) : '');
          setPiPayment(dollars(cfg.piPayment));
        }
      })
      .catch(() => {});
  }, [accountId]);

  // Live P&I from the entered terms, so the user can confirm it matches the
  // statement before saving (and can leave the P&I field blank to use it).
  const rateFraction = parseFloat(rate) / 100;
  const termMonths = Math.round(parseFloat(termYears) * 12);
  const calculatedPI =
    rateFraction >= 0 &&
    rateFraction < 1 &&
    termMonths > 0 &&
    parseFloat(principal) > 0
      ? computePayment(toCents(principal), rateFraction, termMonths)
      : null;

  const onSave = async (close: () => void) => {
    if (!(rateFraction >= 0 && rateFraction < 1)) {
      setError(t('Enter the annual interest rate, e.g. 7'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const enteredPI = toCents(piPayment);
      await send('mortgage-save-config', {
        accountId,
        annualInterestRate: rateFraction,
        originalPrincipal: principal ? toCents(principal) : null,
        startDate: startDate || null,
        termMonths: termMonths > 0 ? termMonths : null,
        piPayment: enteredPI || calculatedPI || null,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSaving(false);
  };

  const dateInputStyle = {
    height: 36,
    padding: '0 10px',
    border: '1px solid ' + theme.formInputBorder,
    borderRadius: 4,
    backgroundColor: theme.tableBackground,
    color: theme.pageText,
    colorScheme: 'light dark',
  } as const;

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
                Enter your loan terms. These drive the amortization schedule,
                payoff date, and how a payment splits into interest and
                principal. Manage taxes and insurance separately with “Adjust
                escrow”, since those change over time.
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
                  placeholder="7"
                />
              </InitialFocus>
            </FormField>

            <FormField>
              <FormLabel
                title={t('Original loan amount ($):')}
                htmlFor="mtg-principal"
              />
              <Input
                id="mtg-principal"
                value={principal}
                onChangeValue={setPrincipal}
                placeholder="404910"
              />
            </FormField>

            <FormField>
              <FormLabel title={t('Loan start date:')} htmlFor="mtg-start" />
              <input
                id="mtg-start"
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={dateInputStyle}
              />
            </FormField>

            <FormField>
              <FormLabel title={t('Term (years):')} htmlFor="mtg-term" />
              <Input
                id="mtg-term"
                value={termYears}
                onChangeValue={setTermYears}
                placeholder="30"
              />
            </FormField>

            <FormField>
              <FormLabel
                title={t('Monthly principal + interest ($):')}
                htmlFor="mtg-pi"
              />
              <Input
                id="mtg-pi"
                value={piPayment}
                onChangeValue={setPiPayment}
                placeholder={
                  calculatedPI ? String(calculatedPI / 100) : '2693.88'
                }
              />
              {calculatedPI != null && (
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.pageTextSubdued,
                    marginTop: 4,
                  }}
                >
                  <Trans>
                    Calculated from your terms: {{ pi: formatMoney(calculatedPI) }}
                    /mo. Leave blank to use it.
                  </Trans>
                </Text>
              )}
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
