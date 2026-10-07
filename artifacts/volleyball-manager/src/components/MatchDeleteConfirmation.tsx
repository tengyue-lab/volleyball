import ConfirmDialog from './ConfirmDialog';

export default function MatchDeleteConfirmation({ completed, pending, error, onCancel, onConfirm }: {
  completed: boolean; pending: boolean; error: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  return <ConfirmDialog
    testId="dialog-delete-match"
    title={completed ? 'Delete completed match?' : 'Delete this draft match?'}
    confirmLabel="Delete Match"
    pendingLabel="Deleting…"
    pending={pending}
    error={error}
    onCancel={onCancel}
    onConfirm={onConfirm}
  >
    <p>{completed
      ? 'This will reverse all ELO, rank, matches played and priority changes from this match, then delete it. This cannot be undone.'
      : 'The saved teams and any draft assignments will be discarded.'}</p>
  </ConfirmDialog>;
}
