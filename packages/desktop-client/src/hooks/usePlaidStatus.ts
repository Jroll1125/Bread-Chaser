import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import type { PlaidStatus } from '@actual-app/core/types/models';

// Unlike the other bank-sync providers, Plaid runs natively in the desktop
// app - no sync server involved - so this doesn't wait for server status.
export function usePlaidStatus() {
  const [plaidStatus, setPlaidStatus] = useState<PlaidStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      try {
        setPlaidStatus(await send('plaid-status'));
      } catch {
        setPlaidStatus(null);
      }
      setIsLoading(false);
    }
    void fetch();
  }, []);

  return { plaidStatus, isLoading };
}
