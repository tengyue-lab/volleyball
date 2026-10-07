import { useEffect, useRef } from 'react';

export default function ConfirmDialog({ title, children, confirmLabel, pendingLabel, tone = 'danger', pending = false, error = '', onConfirm, onCancel, testId }: {
  title: string; children: React.ReactNode; confirmLabel: string; pendingLabel?: string; tone?: 'danger' | 'warning';
  pending?: boolean; error?: string; onConfirm: () => void; onCancel: () => void; testId: string;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel(); }}>
    <section ref={dialog} tabIndex={-1} className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!pending) onCancel(); }
      if (event.key !== 'Tab') return;
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="modal-head"><div><h2 id={`${testId}-title`}>{title}</h2></div></div>
      <div className="modal-body">
        <div className="confirm-copy">{children}</div>
        {error && <div className="form-error" role="alert" data-testid={`${testId}-error`}>{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-secondary touch-44" onClick={onCancel} disabled={pending} data-testid={`${testId}-cancel`}>Cancel</button>
          <button type="button" className={`button touch-44 ${tone === 'danger' ? 'button-warn' : 'button-primary'}`} onClick={onConfirm} disabled={pending} data-testid={`${testId}-confirm`}>{pending ? pendingLabel ?? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </section>
  </div>;
}
