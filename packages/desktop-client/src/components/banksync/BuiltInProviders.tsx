import { Dialog, DialogTrigger } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { SvgDotsHorizontalTriple } from '@actual-app/components/icons/v1';
import { Menu } from '@actual-app/components/menu';
import { Paragraph } from '@actual-app/components/paragraph';
import { Popover } from '@actual-app/components/popover';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Warning } from '#components/alerts';
import { Link } from '#components/common/Link';

import type { BuiltInBankSyncProviderState } from './useBuiltInBankSyncProviders';

type BuiltInProvidersProps = {
  providers: BuiltInBankSyncProviderState[];
  syncServerStatus: 'offline' | 'no-server' | 'online';
  showPermissionWarning: boolean;
  providersNeedingConfiguration: BuiltInBankSyncProviderState[];
};

export function BuiltInProviders({
  providers,
  syncServerStatus,
  showPermissionWarning,
  providersNeedingConfiguration,
}: BuiltInProvidersProps) {
  const { t } = useTranslation();

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 20, fontWeight: 600 }}>
          <Trans>Providers</Trans>
        </Text>
        <Paragraph style={{ fontSize: 15, color: theme.pageTextSubdued }}>
          <Trans>
            Set up a bank sync provider, then link new accounts or connect an
            existing Bread Chaser account.
          </Trans>
        </Paragraph>
      </View>

      <View
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {providers.map(provider => {
          const isServerMissing =
            provider.requiresServer && syncServerStatus !== 'online';

          return (
            <View
              key={provider.id}
              data-testid={`bank-sync-provider-${provider.id}`}
              style={{
                border: `1px solid ${theme.tableBorder}`,
                borderRadius: 8,
                padding: 16,
                backgroundColor: theme.tableBackground,
                gap: 16,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <View
                  style={{
                    gap: 6,
                    flex: 1,
                  }}
                >
                  <Text style={{ fontSize: 17, fontWeight: 600 }}>
                    {provider.displayName}
                  </Text>
                  <Text
                    style={{
                      color: provider.isConfigured
                        ? theme.noticeTextDark
                        : theme.pageTextSubdued,
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    {isServerMissing ? (
                      <Trans>Requires a sync server</Trans>
                    ) : provider.isConfigured ? (
                      <Trans>Configured</Trans>
                    ) : (
                      <Trans>Not configured</Trans>
                    )}
                  </Text>
                  <Text
                    style={{
                      color: theme.pageTextSubdued,
                      fontSize: 13,
                    }}
                  >
                    {provider.description}
                  </Text>
                </View>

                {provider.isConfigured && !isServerMissing && (
                  <DialogTrigger>
                    <Button
                      variant="bare"
                      aria-label={t('{{provider}} menu', {
                        provider: provider.displayName,
                      })}
                    >
                      <SvgDotsHorizontalTriple
                        width={15}
                        height={15}
                        style={{ transform: 'rotateZ(90deg)' }}
                      />
                    </Button>

                    <Popover>
                      <Dialog>
                        <Menu
                          onMenuSelect={item => {
                            if (item === 'reconfigure') {
                              void provider.onReset();
                            }
                          }}
                          items={[
                            {
                              name: 'reconfigure',
                              text: t('Reset {{provider}} credentials', {
                                provider: provider.displayName,
                              }),
                            },
                          ]}
                        />
                      </Dialog>
                    </Popover>
                  </DialogTrigger>
                )}
              </View>

              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  variant="bare"
                  isDisabled={!provider.canConfigure || isServerMissing}
                  onPress={() => provider.onConfigure()}
                >
                  {provider.isConfigured ? (
                    <Trans>Edit setup</Trans>
                  ) : (
                    <Trans>Set up</Trans>
                  )}
                </Button>
                <ButtonWithLoading
                  variant="primary"
                  isDisabled={!provider.isConfigured || isServerMissing}
                  isLoading={provider.isLoading}
                  onPress={() => provider.onLink()}
                >
                  <Trans>Link bank account</Trans>
                </ButtonWithLoading>
              </View>
            </View>
          );
        })}
      </View>

      {syncServerStatus !== 'online' && (
        <Paragraph style={{ fontSize: 14, color: theme.pageTextSubdued }}>
          <Trans>
            GoCardless, SimpleFIN, and Pluggy.ai route through a Bread Chaser
            server — connect one to enable{' '}
            <Link
              variant="external"
              to="https://actualbudget.org/docs/advanced/bank-sync"
              linkColor="muted"
            >
              those providers
            </Link>
            . Plaid works without a server.
          </Trans>
        </Paragraph>
      )}

      {showPermissionWarning && (
        <Warning>
          <Trans>
            You don&apos;t have the required permissions to configure bank sync
            providers. Please contact an Admin to configure
          </Trans>{' '}
          {providersNeedingConfiguration
            .map(provider => provider.displayName)
            .join(' or ')}
          .
        </Warning>
      )}
    </View>
  );
}
