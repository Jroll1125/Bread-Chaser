import React, { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { currentDay } from '@actual-app/core/shared/months';
import { format as formatDate, parseISO } from 'date-fns';

import { Error as ErrorAlert } from '#components/alerts';
import { useDateFormat } from '#hooks/useDateFormat';
import {
  Modal,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import type { Modal as ModalType } from '#modals/modalsSlice';

type MortgageEscrowModalProps = Extract<
  ModalType,
  { name: 'mortgage-escrow' }
>['options'];

type Period = {
  id: string;
  effectiveDate: string;
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

function toCents(v: string): number {
  return Math.round((parseFloat(v) || 0) * 100);
}

export function MortgageEscrowModal({ accountId }: MortgageEscrowModalProps) {
  const { t } = useTranslation();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const [periods, setPeriods] = useState<Period[]>([]);
  const [effectiveDate, setEffectiveDate] = useState(currentDay());
  const [tax, setTax] = useState('');
  const [insurance, setInsurance] = useState('');
  const [pmi, setPmi] = useState('');
  const [annualInsurance, setAnnualInsurance] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const cfg = await send('mortgage-get-config', { accountId });
    setPeriods(cfg?.escrowPeriods ?? []);
  }, [accountId]);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  const onAdd = async () => {
    if (!effectiveDate) {
      setError(t('Pick the date this amount takes effect.'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await send('mortgage-set-escrow', {
        accountId,
        effectiveDate,
        propertyTaxMonthly: toCents(tax),
        homeInsuranceMonthly: toCents(insurance),
        pmiMonthly: toCents(pmi),
      });
      setTax('');
      setInsurance('');
      setPmi('');
      setAnnualInsurance('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsSaving(false);
  };

  const onRemove = async (id: string) => {
    await send('mortgage-delete-escrow', { id });
    await reload();
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
    <Modal name="mortgage-escrow" containerProps={{ style: { width: 500 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Escrow (taxes & insurance)')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 12 }}>
            <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
              <Trans>
                Escrow changes at each annual analysis. Record each amount with
                the date it took effect — a payment split uses whichever was in
                force on the payment’s date.
              </Trans>
            </Text>

            {periods.length > 0 && (
              <View style={{ gap: 4 }}>
                {periods.map(p => {
                  const total =
                    p.propertyTaxMonthly +
                    p.homeInsuranceMonthly +
                    p.pmiMonthly;
                  return (
                    <View
                      key={p.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 8px',
                        borderBottom: '1px solid ' + theme.tableBorder,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: 500 }}>
                          {money(total)}/mo
                          <Text style={{ color: theme.pageTextSubdued }}>
                            {' '}
                            <Trans>
                              from{' '}
                              {{
                                date: formatDate(
                                  parseISO(p.effectiveDate),
                                  dateFormat,
                                ),
                              }}
                            </Trans>
                          </Text>
                        </Text>
                        <Text
                          style={{ fontSize: 12, color: theme.pageTextSubdued }}
                        >
                          <Trans>
                            Tax {{ tax: money(p.propertyTaxMonthly) }} · Insurance{' '}
                            {{ ins: money(p.homeInsuranceMonthly) }} · PMI{' '}
                            {{ pmi: money(p.pmiMonthly) }}
                          </Trans>
                        </Text>
                      </View>
                      <Button
                        variant="bare"
                        onPress={() => {
                          void onRemove(p.id);
                        }}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    </View>
                  );
                })}
              </View>
            )}

            <View
              style={{
                gap: 10,
                paddingTop: 8,
                borderTop: '1px solid ' + theme.tableBorder,
              }}
            >
              <Text style={{ fontWeight: 500 }}>
                <Trans>Add an escrow amount</Trans>
              </Text>
              <FormField>
                <FormLabel title={t('Takes effect on:')} htmlFor="esc-date" />
                <input
                  id="esc-date"
                  type="date"
                  value={effectiveDate}
                  onChange={e => {
                    setEffectiveDate(e.target.value);
                    setError(null);
                  }}
                  style={dateInputStyle}
                />
              </FormField>
              <FormField>
                <FormLabel
                  title={t('Annual insurance premium ($/yr):')}
                  htmlFor="esc-annual-ins"
                />
                <Input
                  id="esc-annual-ins"
                  value={annualInsurance}
                  onChangeValue={v => {
                    setAnnualInsurance(v);
                    const yearly = parseFloat(v);
                    if (!Number.isNaN(yearly)) {
                      setInsurance((yearly / 12).toFixed(2));
                    }
                  }}
                  placeholder="1435"
                />
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.pageTextSubdued,
                    marginTop: 2,
                  }}
                >
                  <Trans>Fills the monthly insurance below (÷ 12).</Trans>
                </Text>
              </FormField>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <FormField style={{ flex: 1 }}>
                  <FormLabel title={t('Property tax ($/mo):')} htmlFor="esc-tax" />
                  <Input
                    id="esc-tax"
                    value={tax}
                    onChangeValue={setTax}
                    placeholder="0"
                  />
                </FormField>
                <FormField style={{ flex: 1 }}>
                  <FormLabel title={t('Insurance ($/mo):')} htmlFor="esc-ins" />
                  <Input
                    id="esc-ins"
                    value={insurance}
                    onChangeValue={setInsurance}
                    placeholder="0"
                  />
                </FormField>
                <FormField style={{ flex: 1 }}>
                  <FormLabel title={t('PMI ($/mo):')} htmlFor="esc-pmi" />
                  <Input
                    id="esc-pmi"
                    value={pmi}
                    onChangeValue={setPmi}
                    placeholder="0"
                  />
                </FormField>
              </View>

              {error && <ErrorAlert>{error}</ErrorAlert>}

              <ButtonWithLoading
                variant="primary"
                isLoading={isSaving}
                onPress={() => {
                  void onAdd();
                }}
              >
                <Trans>Add escrow amount</Trans>
              </ButtonWithLoading>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
