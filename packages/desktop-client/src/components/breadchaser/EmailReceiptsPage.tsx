import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { EmailReceiptsCard } from '#components/breadchaser/EmailReceiptsCard';
import { MOBILE_NAV_HEIGHT } from '#components/mobile/MobileNavTabs';
import { Page } from '#components/Page';
import { useGlobalPref } from '#hooks/useGlobalPref';

export function EmailReceiptsPage() {
  const { t } = useTranslation();
  const [floatingSidebar] = useGlobalPref('floatingSidebar');
  const { isNarrowWidth } = useResponsive();

  return (
    <Page
      header={t('Email receipts')}
      style={{
        marginInline: floatingSidebar && !isNarrowWidth ? 'auto' : 0,
        paddingBottom: MOBILE_NAV_HEIGHT,
      }}
    >
      <View style={{ marginTop: '1em', maxWidth: 600, gap: 12 }}>
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Receipts from your Gmail are read by a local AI model on this machine
            and matched to your imported transactions — nothing leaves your
            computer. Configure the connection and extraction below.
          </Trans>
        </Text>
        <EmailReceiptsCard />
      </View>
    </Page>
  );
}
