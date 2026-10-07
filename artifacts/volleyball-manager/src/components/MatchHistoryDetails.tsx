import { useState } from 'react';

type Snap = { id: number; name: string; assignedPosition?: string | null };
type Change = { id?: number; playerId: number; changeAmount: number | null; action?: string };
export interface HistoryMatch { id: number; teamA: Snap[]; teamB: Snap[]; eloChanges: Change[] }

const byName = (a: { name: string; id: number }, b: { name: string; id: number }) => a.name.localeCompare(b.name) || a.id - b.id;

/** Privacy-safe: visible changes sorted descending, private ones listed after, never zero-filled. */
export function sortedEloChanges(match: HistoryMatch): { id: number; name: string; amount: number | null }[] {
  const rows = [...match.teamA, ...match.teamB].map((player) => {
    const entries = match.eloChanges.filter((entry) => entry.playerId === player.id && (entry.action === undefined || entry.action === 'result'));
    const entry = entries.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    return { id: player.id, name: player.name, amount: entry && typeof entry.changeAmount === 'number' ? entry.changeAmount : null };
  });
  const visible = rows.filter((row) => row.amount !== null).sort((a, b) => (b.amount as number) - (a.amount as number) || byName(a, b));
  const hidden = rows.filter((row) => row.amount === null).sort(byName);
  return [...visible, ...hidden];
}

export function formatChange(amount: number | null): string {
  return amount === null ? 'Private' : `${amount > 0 ? '+' : ''}${amount}`;
}

function Disclosure({ id, matchId, label, open, onToggle, children }: { id: string; matchId: number; label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <div className="history-disclosure">
    <button type="button" className="history-disclosure-trigger" aria-expanded={open} aria-controls={`${id}-${matchId}`} onClick={onToggle} data-testid={`button-${id}-${matchId}`}>
      <span>{label}</span><span aria-hidden="true" className="history-chevron" style={{ transform: open ? 'rotate(180deg)' : undefined }}>v</span>
    </button>
    {open && <div id={`${id}-${matchId}`} className="history-disclosure-panel" data-testid={`panel-${id}-${matchId}`}>{children}</div>}
  </div>;
}

export default function MatchHistoryDetails({ match, initialOpen, eloState = 'ready', onEloOpen, onEloRetry }: {
  match: HistoryMatch; initialOpen?: { team?: boolean; elo?: boolean };
  eloState?: 'ready' | 'loading' | 'error'; onEloOpen?: () => void; onEloRetry?: () => void;
}) {
  const [teamOpen, setTeamOpen] = useState(initialOpen?.team ?? false);
  const [eloOpen, setEloOpen] = useState(initialOpen?.elo ?? false);
  const roster = (label: string, team: Snap[]) => <section className="history-team" aria-label={label}>
    <h4>{label}</h4>
    <ul>{team.map((player) => <li key={player.id}><strong>{player.name}</strong><span>{player.assignedPosition || 'Position not recorded'}</span></li>)}</ul>
  </section>;
  return <div className="history-details">
    <Disclosure id="team-detail" matchId={match.id} label="Team Detail" open={teamOpen} onToggle={() => setTeamOpen((v) => !v)}>
      <div className="history-teams">{roster('Team A', match.teamA)}{roster('Team B', match.teamB)}</div>
    </Disclosure>
    <Disclosure id="elo-changes" matchId={match.id} label="ELO Changes" open={eloOpen} onToggle={() => { if (!eloOpen) onEloOpen?.(); setEloOpen((v) => !v); }}>
      {eloState === 'loading' ? <p className="field-hint" role="status">Loading ELO changes…</p> : eloState === 'error' ? <div className="form-error" role="alert">ELO changes could not be loaded. <button type="button" className="text-button" onClick={onEloRetry}>Try again</button></div> : <ul className="history-elo-list">{sortedEloChanges(match).map((row) => <li key={row.id}>
        <span>{row.name}</span>
        <strong className={row.amount === null ? 'elo-change-private' : row.amount > 0 ? 'elo-change-positive' : row.amount < 0 ? 'elo-change-negative' : 'elo-change-zero'} data-testid={`text-elo-change-${match.id}-${row.id}`}>{formatChange(row.amount)}</strong>
      </li>)}</ul>}
    </Disclosure>
  </div>;
}
