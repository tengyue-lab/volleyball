import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getGetMatchQueryKey, getListMatchesQueryKey, useVoidMatch } from '@workspace/api-client-react';
import type { Match } from '@workspace/api-client-react';
import { useAccess } from '@/auth';
import { useMatchSession } from '@/match-session-context';
import { clearDeletedMatchSession, restoreFailedDeletionSession } from '@/match-session';
import ConfirmDialog from './ConfirmDialog';

export default function VoidMatchButton({ match, beforeVoid }: {
  match: Match; beforeVoid: () => void;
}) {
  const { isAdmin } = useAccess();
  const { draft, setDraft } = useMatchSession();
  const client = useQueryClient();
  const mutation = useVoidMatch();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  if (!isAdmin || match.playDisposition === 'voided') return null;

  async function confirm() {
    if (mutation.isPending) return;
    const previous = draft.editingMatchId === match.id ? draft : null;
    flushSync(() => {
      setDraft((current) => clearDeletedMatchSession(current, match.id));
      beforeVoid();
    });
    try {
      const updated = await mutation.mutateAsync({ matchId: match.id });
      await client.cancelQueries();
      client.setQueryData(getGetMatchQueryKey(match.id), updated);
      client.setQueryData<Match[]>(getListMatchesQueryKey(), (current) =>
        current?.filter((row) => row.id !== match.id));
      await client.invalidateQueries();
      setConfirming(false);
    } catch (failure) {
      if (previous) setDraft((current) => restoreFailedDeletionSession(current, previous));
      setError(failure instanceof Error ? failure.message : 'Could not mark this match never played.');
    }
  }

  return <>
    <button className="button button-secondary touch-44" data-testid={`button-void-match-${match.id}`}
      disabled={mutation.isPending} onClick={() => { setError(''); setConfirming(true); }}>
      Mark never played
    </button>
    {confirming && <ConfirmDialog title="Mark this match never played?"
      testId={`dialog-void-match-${match.id}`} confirmLabel="Mark never played"
      pending={mutation.isPending} error={error} onConfirm={() => void confirm()}
      onCancel={() => setConfirming(false)}>
      Any active ELO and priority changes will be reversed. This match will not count toward position rotation.
      The roster and audit history will be retained, but it will no longer appear in Current Match or Match History.
    </ConfirmDialog>}
  </>;
}
