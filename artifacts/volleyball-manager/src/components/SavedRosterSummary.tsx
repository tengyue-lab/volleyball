export interface SummaryRoster { id: number; matchDate?: string | null; createdAt: string; teamA: unknown[]; teamB: unknown[]; draftEditable?: boolean }

export function rosterLabel(match: SummaryRoster): string {
  return `Roster / ${String(match.id).padStart(3, '0')}${match.matchDate ? ` · ${match.matchDate}` : ''}`;
}

export default function SavedRosterSummary({ rosters, targetId, busy, onSelect, onContinue, onReset }: {
  rosters: SummaryRoster[]; targetId: number | null; busy: boolean;
  onSelect: (id: number) => void; onContinue: () => void; onReset: () => void;
}) {
  if (!rosters.length) return null;
  const target = rosters.find((roster) => roster.id === targetId) ?? null;
  const protectedTarget = !!target && target.draftEditable !== true;
  return <section className="panel saved-summary" aria-label="Saved upcoming rosters" data-testid="summary-saved-rosters">
    <div className="panel-head"><div><h2 className="panel-title">Saved upcoming {rosters.length === 1 ? 'roster' : 'rosters'}</h2><div className="panel-note">{rosters.length > 1 ? 'Choose the roster to continue or reset.' : 'Continue where you left off, or reset it.'}</div></div></div>
    <div className="saved-summary-body">
      <ul className="saved-summary-list" role={rosters.length > 1 ? 'radiogroup' : undefined} aria-label="Choose saved roster">
        {rosters.map((roster) => <li key={roster.id}>
          <label className={`saved-summary-row ${roster.id === targetId ? 'selected' : ''}`}>
            <input type="radio" name="saved-roster-target" checked={roster.id === targetId} disabled={busy} onChange={() => onSelect(roster.id)} data-testid={`radio-saved-roster-${roster.id}`} />
            <span><strong>{rosterLabel(roster)}</strong><small>{roster.teamA.length} vs {roster.teamB.length} players{roster.draftEditable === true ? '' : ' · Protected, has result history'}</small></span>
          </label>
        </li>)}
      </ul>
      {protectedTarget && <p className="field-hint" role="status">This roster has result history and cannot be edited or reset here.</p>}
      <div className="saved-summary-actions">
        <button type="button" className="button button-warn touch-44" disabled={!target || protectedTarget || busy} onClick={onReset} data-testid="button-reset-current-match">Reset Current Match</button>
        <button type="button" className="button button-primary touch-44" disabled={!target || protectedTarget || busy} onClick={onContinue} data-testid="button-continue-team-assignment">Continue to Team Assignment</button>
      </div>
    </div>
  </section>;
}
