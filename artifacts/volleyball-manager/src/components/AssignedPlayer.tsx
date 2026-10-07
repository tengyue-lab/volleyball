import { useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { ArrowLeftRight, Lock, LockOpen, X } from 'lucide-react';
import type { RatedPlayer as Player } from '@/auth';
import type { MatchPosition, MatchPositionAssignment } from '@/match-balancing';
import { preferredLockPositions } from '@/match-lock-options';
import './assigned-player.css';

const ABBR: Record<MatchPosition, string> = {
  Setter: 'S',
  'Outside Hitter': 'OH',
  'Middle Blocker': 'MB',
  Opposite: 'OPP',
  Libero: 'L',
};

function RoleBadge({ assignedPosition, status }: { assignedPosition: MatchPosition; status: 'preferred' | 'filled' }) {
  return <span className={`assignment-badge ${status}`} aria-label={`${assignedPosition}: ${status}`}>
    <span aria-hidden="true">{status === 'preferred' ? '✓' : '!'}</span>
    {status === 'preferred' ? 'Preferred' : 'Filled'}
  </span>;
}

interface Props {
  player: Player;
  roleAssignment?: MatchPositionAssignment;
  team: 'A' | 'B';
  swapSelectionId: number | null;
  swapSelectionTeam: 'A' | 'B' | null;
  onSelectSwap: (id: number) => void;
  onRemove: (id: number) => void;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>, id: number) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>, targetId: number) => void;
  manual?: boolean;
  lockedPosition?: MatchPosition;
  canSwap?: boolean;
  onLock?: (position: MatchPosition) => boolean;
  onUnlock?: () => void;
}

export default function AssignedPlayer({
  player, roleAssignment, team, swapSelectionId, swapSelectionTeam,
  onSelectSwap, onRemove, onDragStart, onDrop,
  manual = false, lockedPosition, canSwap = true, onLock, onUnlock,
}: Props) {
  const [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState<MatchPosition | null>(null);
  const locked = !!lockedPosition;
  const frozen = locked || !canSwap;
  const isSelectedForSwap = swapSelectionId === player.id;
  const isSwapTarget = swapSelectionId !== null && swapSelectionTeam !== team;
  const swapLabel = isSelectedForSwap ? 'Cancel' : isSwapTarget ? 'Swap' : 'Choose';
  const lockOptions = preferredLockPositions(player.positions);

  const choose = (position: MatchPosition) => {
    const ok = onLock ? onLock(position) : false;
    if (ok) { setOpen(false); setRejected(null); } else setRejected(position);
  };

  return <div
    className={`assigned-player ap-wrap ${manual ? 'ap-manual' : ''} ${locked ? 'ap-locked' : ''}`}
    draggable={!frozen}
    onDragStart={(event) => { if (frozen) { event.preventDefault(); return; } onDragStart(event, player.id); }}
    onDragOver={(event) => { if (!locked) event.preventDefault(); }}
    onDrop={(event) => { if (locked) { event.preventDefault(); return; } onDrop(event, player.id); }}
    data-testid={`assigned-player-${player.id}`}
  >
    <div className="assigned-player-copy">
      <strong>{player.name}</strong>
      {locked ? <div className="assigned-role-line ap-locked-line" data-testid={`text-locked-${player.id}`}>
        <span className="ap-lock-icon" aria-hidden="true"><Lock size={11} /></span>
        <strong className="assigned-role-name">{lockedPosition} — Locked</strong>
        {roleAssignment && <><RoleBadge assignedPosition={roleAssignment.assignedPosition} status={roleAssignment.assignmentStatus} /><small>Rank {roleAssignment.preferenceRank}</small></>}
      </div> : roleAssignment ? <div className="assigned-role-line">
        <strong className="assigned-role-name">{roleAssignment.assignedPosition}</strong>
        <RoleBadge assignedPosition={roleAssignment.assignedPosition} status={roleAssignment.assignmentStatus} />
        {roleAssignment.preferenceRank !== null && <small>Rank {roleAssignment.preferenceRank}</small>}
      </div> : manual ? <small className="role-pending">Pending — press Fill</small>
        : <small className="role-pending">Role assigned when both sides are complete</small>}
      <small>Profile: {player.positions.join(' · ')}</small>
      <span className="assigned-elo">ELO {player.elo.toLocaleString()}</span>
    </div>
    <div className="assigned-player-actions">
      {manual && (locked
        ? <button type="button" className="ap-btn" onClick={() => { setOpen(false); onUnlock?.(); }} aria-label={`Unlock ${player.name}`} data-testid={`button-unlock-${player.id}`}><LockOpen size={12} />Unlock</button>
        : <button type="button" className="ap-btn" aria-expanded={open} aria-controls={`lock-selector-${player.id}`} aria-label={`Lock role for ${player.name}`} onClick={() => { setOpen((v) => !v); setRejected(null); }} data-testid={`button-lock-${player.id}`}><Lock size={12} />Lock</button>)}
      <button
        className={`swap-player ${isSelectedForSwap ? 'selected' : ''}`}
        disabled={frozen}
        aria-label={isSelectedForSwap ? `Cancel swap for ${player.name}` : isSwapTarget ? `Swap ${player.name} with selected player` : `Choose ${player.name} for swap`}
        aria-pressed={isSelectedForSwap}
        onClick={() => onSelectSwap(player.id)}
        data-testid={`button-swap-player-${player.id}`}
      ><ArrowLeftRight size={12} />{swapLabel}</button>
      <button className="remove-player" disabled={locked} aria-label={`Remove ${player.name} from Team ${team}`} onClick={() => onRemove(player.id)} data-testid={`button-unassign-${player.id}`}><X size={14} /></button>
    </div>
    {manual && open && !locked && <fieldset className="ap-selector-wrap" id={`lock-selector-${player.id}`}>
      <div className="ap-selector" role="group" aria-label={`Select role to lock for ${player.name}`}>
        {lockOptions.map((position) => <button
          key={position}
          type="button"
          className="ap-option"
          onClick={() => choose(position)}
          aria-label={`Lock ${player.name} as ${position}`}
          data-testid={`button-lock-option-${player.id}-${ABBR[position]}`}
        ><b>{ABBR[position]}</b>{position}</button>)}
      </div>
      {rejected && <div className="ap-error" role="alert">{rejected} cannot be locked here. Choose another role.</div>}
    </fieldset>}
  </div>;
}
