import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { BankSyncCard } from '#components/breadchaser/BankSyncCard';
import { EmailReceiptsCard } from '#components/breadchaser/EmailReceiptsCard';
import { Page } from '#components/Page';

type PillarStatus = 'in-progress' | 'planned';

type PillarCardProps = {
  title: string;
  description: string;
  status: PillarStatus;
};

function PillarCard({ title, description, status }: PillarCardProps) {
  const { t } = useTranslation();

  return (
    <View
      style={{
        backgroundColor: theme.cardBackground,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        padding: 15,
        gap: 5,
        flexGrow: 1,
        flexBasis: 250,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: 600, color: theme.pageText }}>
          {title}
        </Text>
        <Text
          style={{
            backgroundColor: theme.pillBackground,
            color: theme.pillText,
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {status === 'in-progress' ? t('In progress') : t('Planned')}
        </Text>
      </View>
      <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
        {description}
      </Text>
    </View>
  );
}

export function BreadChaserPage() {
  const { t } = useTranslation();

  return (
    <Page header={t('Bread Chaser')}>
      <View style={{ maxWidth: 800, gap: 20, paddingTop: 20 }}>
        <Text style={{ color: theme.pageText, fontSize: 14, lineHeight: 1.5 }}>
          <Trans>
            Home base for everything that makes this app yours. Each pillar
            below moves in as it comes online.
          </Trans>
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 15 }}>
          <BankSyncCard />
          <EmailReceiptsCard />
          <PillarCard
            title={t('Dedup review')}
            description={t(
              'When two sources report the same transaction, review and merge them in one place.',
            )}
            status="planned"
          />
          <PillarCard
            title={t('AI enrichment')}
            description={t(
              'Suggested payees, categories, and notes for imported transactions. Always suggest-only.',
            )}
            status="planned"
          />
        </View>
      </View>
    </Page>
  );
}
