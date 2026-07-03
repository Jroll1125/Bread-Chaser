import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import { useCategories } from '#hooks/useCategories';

type ScanGroup = {
  key: string;
  payee: string;
  payeeIds: string[];
  transactionIds: string[];
  count: number;
  group: string;
  category: string;
  confidence: number;
  via: 'payee' | 'tokens';
};
type ScanResult = {
  hasSeed: boolean;
  uncategorized: number;
  matched: number;
  groups: ScanGroup[];
};

const cell: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: 13,
  verticalAlign: 'middle',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const headCell: React.CSSProperties = {
  ...cell,
  textAlign: 'left',
  fontWeight: 500,
  color: theme.pageTextSubdued,
};
const fieldStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: 4,
  borderRadius: 4,
  border: '1px solid ' + theme.tableBorder,
  backgroundColor: theme.tableBackground,
  color: theme.pageText,
};

/**
 * Auto-categorization panel: scans uncategorized transactions against the
 * local ground-truth model, shows suggestions grouped by payee, and applies
 * the accepted ones (optionally minting a payee rule so future imports
 * categorize themselves). Nothing leaves the machine.
 */
export function AutoCategorizePanel() {
  const { t } = useTranslation();
  const { data: categoryData } = useCategories();
  const categoryGroups = categoryData?.grouped ?? [];

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [createRules, setCreateRules] = useState(true);

  const runScan = async () => {
    setIsScanning(true);
    setError(null);
    setResult(null);
    try {
      const res = await send('autocat-scan');
      setScan(res);
      const acc: Record<string, boolean> = {};
      for (const g of res.groups) {
        // Default-accept confident suggestions; leave weak ones for review.
        acc[g.key] = g.confidence >= 0.75;
      }
      setAccepted(acc);
      setOverrides({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsScanning(false);
  };

  const apply = async () => {
    if (!scan) {
      return;
    }
    setIsApplying(true);
    setError(null);
    setResult(null);
    try {
      const items = scan.groups
        .filter(g => accepted[g.key])
        .map(g => {
          const override = overrides[g.key];
          return {
            transactionIds: g.transactionIds,
            payeeIds: g.payeeIds,
            createRule: createRules,
            ...(override
              ? { categoryId: override }
              : { group: g.group, category: g.category }),
          };
        });
      const res = await send('autocat-apply', { items });
      setResult(
        t(
          'Categorized {{applied}} transactions · {{categoriesCreated}} ' +
            'categories created · {{rulesCreated}} rules added.',
          res,
        ),
      );
      setScan(null);
      setAccepted({});
      setOverrides({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsApplying(false);
  };

  const selectedCount = scan
    ? scan.groups.filter(g => accepted[g.key]).length
    : 0;

  return (
    <View
      style={{
        border: '1px solid ' + theme.tableBorder,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '8px 12px',
          backgroundColor: theme.tableRowHeaderBackground,
        }}
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Auto-categorize</Trans>
          {scan ? (
            <Text style={{ color: theme.pageTextSubdued, fontWeight: 400 }}>
              {'  '}
              {t('{{count}} uncategorized · {{matched}} suggested', {
                count: scan.uncategorized,
                matched: scan.matched,
              })}
            </Text>
          ) : null}
        </Text>
        <ButtonWithLoading
          variant="primary"
          isLoading={isScanning}
          isDisabled={isApplying}
          onPress={() => {
            void runScan();
          }}
        >
          {scan ? <Trans>Rescan</Trans> : <Trans>Scan</Trans>}
        </ButtonWithLoading>
      </View>

      <View style={{ padding: '10px 12px', gap: 10 }}>
        {error && <ErrorAlert>{error}</ErrorAlert>}
        {result && (
          <Text style={{ color: theme.noticeText }}>{result}</Text>
        )}

        {!scan && !result && (
          <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
            <Trans>
              Suggest categories for your uncategorized transactions, learned
              from your own history — on this machine. Click Scan to review
              suggestions before anything is applied.
            </Trans>
          </Text>
        )}

        {scan && !scan.hasSeed && (
          <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
            <Trans>
              No training data found. Add an autocat-seed.json file to your data
              folder (built from your categorized history) and scan again.
            </Trans>
          </Text>
        )}

        {scan && scan.hasSeed && scan.groups.length === 0 && (
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>No confident suggestions right now.</Trans>
          </Text>
        )}

        {scan && scan.groups.length > 0 && (
          <>
            <View style={{ maxHeight: 460, overflowY: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  tableLayout: 'fixed',
                  borderCollapse: 'collapse',
                }}
              >
                <colgroup>
                  <col style={{ width: '5%' }} />
                  <col style={{ width: '30%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '45%' }} />
                  <col style={{ width: '12%' }} />
                </colgroup>
                <thead>
                  <tr
                    style={{
                      backgroundColor: theme.tableRowHeaderBackground,
                      position: 'sticky',
                      top: 0,
                    }}
                  >
                    <th style={headCell} />
                    <th style={headCell}>{t('Payee')}</th>
                    <th style={{ ...headCell, textAlign: 'right' }}>#</th>
                    <th style={headCell}>{t('Suggested category')}</th>
                    <th style={{ ...headCell, textAlign: 'right' }}>
                      {t('Conf.')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scan.groups.map(g => (
                    <tr
                      key={g.key}
                      style={{ borderTop: '1px solid ' + theme.tableBorder }}
                    >
                      <td style={{ ...cell, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={!!accepted[g.key]}
                          aria-label={t('Accept suggestion for {{payee}}', {
                            payee: g.payee,
                          })}
                          onChange={e =>
                            setAccepted(prev => ({
                              ...prev,
                              [g.key]: e.target.checked,
                            }))
                          }
                        />
                      </td>
                      <td style={cell} title={g.payee}>
                        {g.payee}
                      </td>
                      <td style={{ ...cell, textAlign: 'right' }}>{g.count}</td>
                      <td style={cell}>
                        <select
                          value={overrides[g.key] ?? ''}
                          aria-label={t('Category for {{payee}}', {
                            payee: g.payee,
                          })}
                          onChange={e =>
                            setOverrides(prev => ({
                              ...prev,
                              [g.key]: e.target.value,
                            }))
                          }
                          style={fieldStyle}
                        >
                          <option value="">
                            {t('✦ New: {{group}}: {{category}}', {
                              group: g.group,
                              category: g.category,
                            })}
                          </option>
                          {categoryGroups
                            .filter(group => !group.hidden)
                            .map(group => (
                              <optgroup key={group.id} label={group.name}>
                                {(group.categories ?? [])
                                  .filter(c => !c.hidden)
                                  .map(c => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                        </select>
                      </td>
                      <td
                        style={{
                          ...cell,
                          textAlign: 'right',
                          color:
                            g.confidence >= 0.75
                              ? theme.noticeText
                              : theme.pageTextSubdued,
                        }}
                        title={g.via === 'payee' ? t('by payee') : t('by name')}
                      >
                        {Math.round(g.confidence * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </View>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  color: theme.pageTextSubdued,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={createRules}
                  onChange={e => setCreateRules(e.target.checked)}
                />
                <Trans>Also create a rule per payee (auto-categorize future imports)</Trans>
              </label>
              <ButtonWithLoading
                variant="primary"
                isLoading={isApplying}
                isDisabled={selectedCount === 0}
                onPress={() => {
                  void apply();
                }}
              >
                {t('Apply {{count}} selected', { count: selectedCount })}
              </ButtonWithLoading>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
