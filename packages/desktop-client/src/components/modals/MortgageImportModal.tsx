import React, { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
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
import type { Modal as ModalType } from '#modals/modalsSlice';
import { extractPdfText } from '#util/pdfText';

type MortgageImportModalProps = Extract<
  ModalType,
  { name: 'mortgage-import' }
>['options'];

type Proposal = {
  fileName: string;
  status: 'matched' | 'no-match' | 'extract-failed' | 'invalid';
  statementDate: string | null;
  dueDate: string | null;
  matchedTransactionId: string | null;
  matchedDate: string | null;
  payment: number | null;
  interest: number;
  taxAndInsurance: number;
  propertyTax: number;
  homeInsurance: number;
  pmi: number;
  principal: number | null;
};

type Row = Proposal & {
  interestStr: string;
  taxStr: string;
  insStr: string;
  pmiStr: string;
  include: boolean;
  // The statement PDF itself, kept so a successful split can attach it to
  // the payment transaction.
  dataBase64: string;
  attached?: boolean;
  result?: 'ok' | 'error';
  resultMsg?: string;
};

// Statement PDFs are small (~100 KB); chunked btoa keeps the call stack flat.
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}
const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100);
const fromCents = (c: number) => String(c / 100);

const STATUS_LABEL: Record<Proposal['status'], string> = {
  matched: '',
  'no-match': 'No matching payment found in your ledger',
  'extract-failed': 'Could not read this statement',
  invalid: 'Interest + escrow exceed the matched payment',
};

export function MortgageImportModal({ accountId }: MortgageImportModalProps) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<
    'pick' | 'working' | 'review' | 'applying' | 'done'
  >('pick');
  const [working, setWorking] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setError(null);
    setStep('working');
    try {
      setWorking(t('Reading PDFs…'));
      const statements: Array<{ fileName: string; text: string }> = [];
      const pdfData: string[] = [];
      for (const file of Array.from(files)) {
        const text = await extractPdfText(file);
        statements.push({ fileName: file.name, text });
        pdfData.push(await fileToBase64(file));
      }

      setWorking(t('Reading your statements with the local AI…'));
      const proposals = (await send('mortgage-parse-statements', {
        accountId,
        statements,
      })) as Proposal[];

      // Proposals come back 1:1 in input order, so index pairs each one with
      // its PDF bytes.
      setRows(
        proposals.map((p, idx) => ({
          ...p,
          interestStr: fromCents(p.interest),
          taxStr: fromCents(p.propertyTax),
          insStr: fromCents(p.homeInsurance),
          pmiStr: fromCents(p.pmi),
          include: p.status === 'matched',
          dataBase64: pdfData[idx] ?? '',
        })),
      );
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('pick');
    }
  };

  const update = (i: number, patch: Partial<Row>) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const principalOf = (r: Row): number =>
    (r.payment ?? 0) -
    toCents(r.interestStr) -
    toCents(r.taxStr) -
    toCents(r.insStr) -
    toCents(r.pmiStr);

  const onApply = async () => {
    setStep('applying');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.include || r.status !== 'matched' || !r.matchedTransactionId) {
        continue;
      }
      try {
        await send('mortgage-split-payment', {
          transactionId: r.matchedTransactionId,
          mortgageAccountId: accountId,
          overrides: {
            interest: toCents(r.interestStr),
            propertyTax: toCents(r.taxStr),
            homeInsurance: toCents(r.insStr),
            pmi: toCents(r.pmiStr),
          },
        });
        update(i, { result: 'ok' });

        // Attach the statement PDF to the payment it just split. sourceKey
        // makes re-imports idempotent; a failed attach never fails the split.
        if (r.dataBase64) {
          try {
            await send('attachments-add-data', {
              transactionId: r.matchedTransactionId,
              fileName: r.fileName,
              dataBase64: r.dataBase64,
              contentType: 'application/pdf',
              sourceKey:
                'mortgage-stmt:' + accountId + ':' + (r.statementDate ?? r.fileName),
            });
            update(i, { attached: true });
          } catch (attachErr) {
            update(i, {
              resultMsg: t('Split applied, but attaching the PDF failed: {{message}}', {
                message:
                  attachErr instanceof Error
                    ? attachErr.message
                    : String(attachErr),
              }),
            });
          }
        }
      } catch (err) {
        update(i, {
          result: 'error',
          resultMsg: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setStep('done');
  };

  const includable = rows.filter(
    r => r.include && r.status === 'matched',
  ).length;
  const appliedOk = rows.filter(r => r.result === 'ok').length;

  const num = {
    width: 74,
    textAlign: 'right',
    padding: '2px 6px',
    height: 28,
  } as const;
  const cell = { padding: '6px 8px', fontSize: 13 } as const;
  const head = {
    ...cell,
    color: theme.pageTextSubdued,
    fontWeight: 400,
    textAlign: 'right',
  } as const;

  return (
    <Modal name="mortgage-import" containerProps={{ style: { width: 820 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Import splits from statements')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          {step === 'pick' && (
            <View style={{ gap: 12 }}>
              <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
                <Trans>
                  Pick your mortgage statement PDFs. Your local AI reads the
                  interest and escrow off each one, matches it to the payment in
                  your ledger, and prepares the split — you review everything
                  before anything is applied. Needs Ollama running.
                </Trans>
              </Text>
              {error && <ErrorAlert>{error}</ErrorAlert>}
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                style={{ display: 'none' }}
                onChange={e => {
                  void onFiles(e.target.value ? e.target.files : null);
                }}
              />
              <Button
                variant="primary"
                onPress={() => fileInput.current?.click()}
              >
                <Trans>Choose statement PDFs</Trans>
              </Button>
            </View>
          )}

          {step === 'working' && (
            <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
              <Text style={{ fontWeight: 500 }}>{working}</Text>
              <Text style={{ color: theme.pageTextSubdued, fontSize: 13 }}>
                <Trans>This can take a few seconds per statement.</Trans>
              </Text>
            </View>
          )}

          {(step === 'review' || step === 'applying' || step === 'done') && (
            <View style={{ gap: 10 }}>
              <View style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid ' + theme.tableBorder }}>
                      <th style={{ ...head, textAlign: 'center', width: 30 }} />
                      <th style={{ ...cell, textAlign: 'left', fontWeight: 400, color: theme.pageTextSubdued }}>
                        <Trans>Payment</Trans>
                      </th>
                      <th style={head}>
                        <Trans>Interest</Trans>
                      </th>
                      <th style={head}>
                        <Trans>Tax</Trans>
                      </th>
                      <th style={head}>
                        <Trans>Insurance</Trans>
                      </th>
                      <th style={head}>
                        <Trans>PMI</Trans>
                      </th>
                      <th style={head}>
                        <Trans>Principal</Trans>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const matched = r.status === 'matched';
                      const principal = principalOf(r);
                      const bad = matched && principal <= 0;
                      return (
                        <tr
                          key={r.fileName + i}
                          style={{
                            borderBottom: '1px solid ' + theme.tableBorder,
                            opacity: matched ? 1 : 0.6,
                            backgroundColor:
                              r.result === 'ok'
                                ? theme.noticeBackground
                                : r.result === 'error'
                                  ? theme.errorBackground
                                  : undefined,
                          }}
                        >
                          <td style={{ ...cell, textAlign: 'center' }}>
                            {matched && (
                              <input
                                type="checkbox"
                                checked={r.include}
                                disabled={step !== 'review'}
                                onChange={e =>
                                  update(i, { include: e.target.checked })
                                }
                              />
                            )}
                          </td>
                          <td style={cell}>
                            <Text style={{ fontWeight: 500 }}>
                              {r.payment != null
                                ? money(r.payment)
                                : r.fileName}
                            </Text>
                            <Text
                              style={{
                                fontSize: 11,
                                color: theme.pageTextSubdued,
                              }}
                            >
                              {matched
                                ? r.matchedDate
                                : t(STATUS_LABEL[r.status])}
                              {r.attached && ' 📎'}
                            </Text>
                          </td>
                          {matched ? (
                            <>
                              <td style={cell}>
                                <Input
                                  value={r.interestStr}
                                  onChangeValue={v =>
                                    update(i, { interestStr: v })
                                  }
                                  style={num}
                                  disabled={step !== 'review'}
                                />
                              </td>
                              <td style={cell}>
                                <Input
                                  value={r.taxStr}
                                  onChangeValue={v => update(i, { taxStr: v })}
                                  style={num}
                                  disabled={step !== 'review'}
                                />
                              </td>
                              <td style={cell}>
                                <Input
                                  value={r.insStr}
                                  onChangeValue={v => update(i, { insStr: v })}
                                  style={num}
                                  disabled={step !== 'review'}
                                />
                              </td>
                              <td style={cell}>
                                <Input
                                  value={r.pmiStr}
                                  onChangeValue={v => update(i, { pmiStr: v })}
                                  style={num}
                                  disabled={step !== 'review'}
                                />
                              </td>
                              <td
                                style={{
                                  ...cell,
                                  textAlign: 'right',
                                  fontWeight: 500,
                                  color: bad
                                    ? theme.errorText
                                    : theme.noticeText,
                                }}
                              >
                                {money(principal)}
                                {r.result === 'ok' && ' ✓'}
                              </td>
                            </>
                          ) : (
                            <td colSpan={5} style={{ ...cell, color: theme.pageTextSubdued }}>
                              {t(STATUS_LABEL[r.status])}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </View>

              {step === 'done' && (
                <Text style={{ color: theme.noticeText }}>
                  <Trans>Applied {{ appliedOk }} splits.</Trans>{' '}
                  {rows.some(r => r.result === 'error') && (
                    <Trans>Some failed — see the highlighted rows.</Trans>
                  )}
                </Text>
              )}
            </View>
          )}

          {step === 'review' && (
            <ModalButtons>
              <Button onPress={() => setStep('pick')}>
                <Trans>Back</Trans>
              </Button>
              <ButtonWithLoading
                variant="primary"
                onPress={() => void onApply()}
                isDisabled={includable === 0}
              >
                <Trans>Apply {{ includable }} splits</Trans>
              </ButtonWithLoading>
            </ModalButtons>
          )}
          {step === 'applying' && (
            <View style={{ padding: 12, alignItems: 'center' }}>
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>Applying splits…</Trans>
              </Text>
            </View>
          )}
          {step === 'done' && (
            <ModalButtons>
              <Button variant="primary" onPress={() => state.close()}>
                <Trans>Done</Trans>
              </Button>
            </ModalButtons>
          )}
        </>
      )}
    </Modal>
  );
}
