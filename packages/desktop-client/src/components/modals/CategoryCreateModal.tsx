import React, { useMemo, useState } from 'react';
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
import { useCategories } from '#hooks/useCategories';
import type { Modal as ModalType } from '#modals/modalsSlice';

type CategoryCreateModalProps = Extract<
  ModalType,
  { name: 'category-create' }
>['options'];

const NEW_GROUP = '__new__';

/**
 * Create a category on the fly (from the transaction category picker) while
 * choosing which group it lands in — or spinning up a new group.
 */
export function CategoryCreateModal({
  initialName = '',
  onCreate,
}: CategoryCreateModalProps) {
  const { t } = useTranslation();
  const { data: { grouped: groups = [] } = { grouped: [] }, refetch } =
    useCategories();

  const selectableGroups = useMemo(
    () => groups.filter(g => !g.hidden),
    [groups],
  );
  const defaultGroupId = useMemo(() => {
    const expense = selectableGroups.find(g => !g.is_income);
    return expense?.id ?? selectableGroups[0]?.id ?? NEW_GROUP;
  }, [selectableGroups]);

  const [name, setName] = useState(initialName);
  const [groupId, setGroupId] = useState(defaultGroupId);
  const [newGroupName, setNewGroupName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const onSubmit = async (close: () => void) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('Give the category a name.'));
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      let targetGroupId = groupId;
      let isIncome = false;
      if (groupId === NEW_GROUP) {
        if (!newGroupName.trim()) {
          setError(t('Give the new group a name.'));
          setIsBusy(false);
          return;
        }
        targetGroupId = (await send('category-group-create', {
          name: newGroupName.trim(),
        })) as string;
      } else {
        isIncome = !!selectableGroups.find(g => g.id === groupId)?.is_income;
      }

      const newId = (await send('category-create', {
        name: trimmed,
        groupId: targetGroupId,
        isIncome,
      })) as string;

      await refetch();
      onCreate(newId);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsBusy(false);
    }
  };

  return (
    <Modal name="category-create" containerProps={{ style: { width: 400 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Create category')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 14, padding: '0 4px' }}>
            {error && <ErrorAlert>{error}</ErrorAlert>}

            <View style={{ gap: 4 }}>
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>Category name</Trans>
              </Text>
              <Input value={name} onChangeValue={setName} />
            </View>

            <View style={{ gap: 4 }}>
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>Group</Trans>
              </Text>
              <Select
                value={groupId}
                onChange={setGroupId}
                options={[
                  ...selectableGroups.map(
                    g =>
                      [
                        g.id,
                        g.is_income ? `${g.name} (${t('income')})` : g.name,
                      ] as [string, string],
                  ),
                  [NEW_GROUP, t('➕ New group…')],
                ]}
              />
            </View>

            {groupId === NEW_GROUP && (
              <View style={{ gap: 4 }}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>New group name</Trans>
                </Text>
                <Input
                  value={newGroupName}
                  placeholder={t('Group name')}
                  onChangeValue={setNewGroupName}
                />
              </View>
            )}
          </View>

          <ModalButtons>
            <Button onPress={() => state.close()}>
              <Trans>Cancel</Trans>
            </Button>
            <ButtonWithLoading
              variant="primary"
              isLoading={isBusy}
              isDisabled={!name.trim()}
              onPress={() => void onSubmit(() => state.close())}
            >
              <Trans>Create</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
