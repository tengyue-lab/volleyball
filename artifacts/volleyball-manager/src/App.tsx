import { useEffect, useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent, FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Position,
  useCreateMatch,
  useCreatePlayer,
  useDeletePlayer,
  useGetLeaderboard,
  useGetMatch,
  useGetPlayer,
  useListMatches,
  useListPlayers,
  useUpdatePlayer,
  getGetLeaderboardQueryKey,
  getGetMatchQueryKey,
  getGetPlayerQueryKey,
  getListMatchesQueryKey,
  getListPlayersQueryKey,
} from '@workspace/api-client-react';
import type { Match, Player, PlayerInput, PlayerUpdate, Position as PositionType } from '@workspace/api-client-react';
import { ArrowLeftRight, CalendarDays, Check, ChevronDown, Pencil, Plus, Search, Trophy, Trash2, Users, WandSparkles, X } from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  assignMatchRoles,
  balanceMatchTeams,
  type MatchBalanceResult,
  type MatchPosition,
  type MatchPositionAssignment,
} from '@/match-balancing';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const positions: PositionType[] = [
  Position.Setter,
  Position.Outside_Hitter,
  Position.Middle_Blocker,
  Position.Opposite,
  Position.Libero,
];
const apiPositionByRole: Record<MatchPosition, PositionType> = {
  Setter: Position.Setter,
  'Outside Hitter': Position.Outside_Hitter,
  'Middle Blocker': Position.Middle_Blocker,
  Opposite: Position.Opposite,
  Libero: Position.Libero,
};

function messageFor(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function useNotice() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return { notice, setNotice };
}

function Notice({ text }: { text: string }) {
  return text ? <div className="toast-message" role="status" data-testid="status-notice">{text}</div> : null;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const active = location === '/' ? '/players' : location;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/players" className="brand" data-testid="link-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span><span className="brand-name">SIDEOUT</span><span className="brand-sub">CLUB ROSTER</span></span>
        </Link>
        <div className="nav-label">Team desk</div>
        <nav className="nav-list" aria-label="Main navigation">
          <Link href="/players" className={`nav-link ${active === '/players' ? 'active' : ''}`} data-testid="link-players"><Users size={16} strokeWidth={1.8} /> Players</Link>
          <Link href="/matches" className={`nav-link ${active === '/matches' ? 'active' : ''}`} data-testid="link-matches"><CalendarDays size={16} strokeWidth={1.8} /> Match rosters</Link>
          <Link href="/leaderboard" className={`nav-link ${active === '/leaderboard' ? 'active' : ''}`} data-testid="link-leaderboard"><Trophy size={16} strokeWidth={1.8} /> ELO leaderboard</Link>
        </nav>
        <div className="sidebar-foot"><strong>Weekly club match</strong>Keep the roster ready. Organize both sides before first serve.</div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="crumb">SIDEOUT <span aria-hidden="true">/</span> TEAM MANAGEMENT</span>
          <span className="top-status"><span className="status-dot" /> Club roster workspace</span>
        </header>
        {children}
      </div>
    </div>
  );
}

function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-description">{description}</p></div>
      {children}
    </div>
  );
}

function LoadingState({ lines = 4 }: { lines?: number }) {
  return <div className="state-card" aria-label="Loading"><strong>Getting the team ready</strong>{Array.from({ length: lines }, (_, i) => <div className="skeleton" key={i} />)}</div>;
}

function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="state-card" role="alert"><strong>Could not load this view</strong>{messageFor(error)}<div><button className="button button-secondary" onClick={retry} data-testid="button-retry">Try again</button></div></div>;
}

function EmptyState({ title, copy, action }: { title: string; copy: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol" aria-hidden="true">+</div><h3>{title}</h3><p>{copy}</p>{action}</div>;
}

function PlayerEditor({ playerId, onClose, notify }: { playerId: number | null; onClose: () => void; notify: (text: string) => void }) {
  const queryClient = useQueryClient();
  const playerQuery = useGetPlayer(playerId ?? 0, {
    query: { queryKey: getGetPlayerQueryKey(playerId ?? 0), enabled: playerId !== null },
  });
  const createPlayer = useCreatePlayer();
  const updatePlayer = useUpdatePlayer();
  const [name, setName] = useState('');
  const [elo, setElo] = useState('1000');
  const [selectedPositions, setSelectedPositions] = useState<PositionType[]>([]);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (playerId !== null && playerQuery.data) {
      setName(playerQuery.data.name);
      setElo(String(playerQuery.data.elo));
      setSelectedPositions(playerQuery.data.positions);
    }
    if (playerId === null) {
      setName('');
      setElo('1000');
      setSelectedPositions([]);
    }
  }, [playerId, playerQuery.data]);

  const saving = createPlayer.isPending || updatePlayer.isPending;
  function togglePosition(position: PositionType) {
    setSelectedPositions((current) => current.includes(position) ? current.filter((item) => item !== position) : [...current, position]);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    const cleanName = name.trim();
    const rating = Number(elo);
    if (!cleanName || cleanName.length > 80) return setFormError('Enter a name between 1 and 80 characters.');
    if (!selectedPositions.length) return setFormError('Choose at least one playing position.');
    if (!Number.isFinite(rating) || rating < 0) return setFormError('ELO must be zero or higher.');
    if (playerId === null) {
      const data: PlayerInput = { name: cleanName, positions: selectedPositions, elo: rating };
      createPlayer.mutate({ data }, {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey() }),
          ]);
          notify(`${cleanName} added to the roster.`);
          onClose();
        },
        onError: (error) => setFormError(messageFor(error)),
      });
    } else {
      const data: PlayerUpdate = { name: cleanName, positions: selectedPositions, elo: rating };
      updatePlayer.mutate({ playerId, data }, {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetPlayerQueryKey(playerId) }),
            queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey() }),
          ]);
          notify(`${cleanName}'s player details saved.`);
          onClose();
        },
        onError: (error) => setFormError(messageFor(error)),
      });
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="player-dialog-title">
        <div className="modal-head">
          <div><h2 id="player-dialog-title">{playerId === null ? 'Add a player' : 'Edit player'}</h2><p>{playerId === null ? 'Add someone to the club roster.' : 'Update this player’s roster details.'}</p></div>
          <button className="button button-quiet" onClick={onClose} aria-label="Close dialog" data-testid="button-close-player"><X size={17} /></button>
        </div>
        {playerId !== null && playerQuery.isLoading ? <div className="modal-body"><LoadingState lines={2} /></div> :
          playerId !== null && playerQuery.isError ? <div className="modal-body"><ErrorState error={playerQuery.error} retry={() => void playerQuery.refetch()} /></div> :
            <form className="modal-body" onSubmit={submit}>
              <div className="form-field"><label htmlFor="player-name">Player name</label><input id="player-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus placeholder="e.g. Jordan Lee" data-testid="input-player-name" /></div>
              <div className="form-field"><label htmlFor="player-elo">Starting ELO</label><input id="player-elo" type="number" min="0" step="1" value={elo} onChange={(event) => setElo(event.target.value)} data-testid="input-player-elo" /><div className="field-hint">New players start at 1000. Ratings can be adjusted here.</div></div>
              <fieldset className="form-field" style={{ border: 0, padding: 0, marginLeft: 0, marginRight: 0 }}>
                <legend className="field-label">Playing positions</legend>
                <div className="position-options">{positions.map((position) => <label className="position-option" key={position}><input type="checkbox" checked={selectedPositions.includes(position)} onChange={() => togglePosition(position)} data-testid={`checkbox-position-${position.toLowerCase().replaceAll(' ', '-')}`} />{position}</label>)}</div>
              </fieldset>
              {formError && <div className="form-error" role="alert">{formError}</div>}
              <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} data-testid="button-cancel-player">Cancel</button><button className="button button-primary" type="submit" disabled={saving} data-testid="button-save-player">{saving ? 'Saving…' : playerId === null ? 'Add player' : 'Save changes'}</button></div>
            </form>}
      </section>
    </div>
  );
}

function PlayersPage() {
  const query = useListPlayers();
  const deletePlayer = useDeletePlayer();
  const queryClient = useQueryClient();
  const { notice, setNotice } = useNotice();
  const [editor, setEditor] = useState<'new' | number | null>(null);
  const [search, setSearch] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const players = query.data ?? [];
  const filteredPlayers = useMemo(() => players.filter((player) => `${player.name} ${player.positions.join(' ')}`.toLowerCase().includes(search.toLowerCase())), [players, search]);

  function removePlayer(player: Player) {
    if (!window.confirm(`Remove ${player.name} from the player roster? This cannot be undone.`)) return;
    setDeleteError('');
    deletePlayer.mutate({ playerId: player.id }, {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetPlayerQueryKey(player.id) }),
        ]);
        setNotice(`${player.name} removed from the roster.`);
      },
      onError: (error) => setDeleteError(messageFor(error)),
    });
  }

  return <Shell><main className="content">
    <PageHeader eyebrow="Roster / all players" title="Players" description="Your club roster, all in one place. Keep positions and ratings current for the next match.">
      <button className="button button-primary" onClick={() => setEditor('new')} data-testid="button-add-player"><Plus size={15} /> Add player</button>
    </PageHeader>
    <div className="summary-strip"><span className="summary-num" data-testid="text-player-count">{players.length.toString().padStart(2, '0')}</span> players on roster <span aria-hidden="true">/</span> ELO ratings update after results are introduced</div>
    <section className="panel" aria-label="Player roster">
      <div className="panel-head">
        <div><h2 className="panel-title">Club roster</h2><div className="panel-note">Player profiles, playing positions and current rating</div></div>
        <div className="table-toolbar"><label className="search"><span className="search-icon"><Search size={13} /></span><input type="search" aria-label="Search players" placeholder="Search roster" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-search-players" /></label></div>
      </div>
      {deleteError && <div className="form-error" role="alert" style={{ margin: 12 }}>{deleteError}</div>}
      {query.isLoading ? <div><LoadingState /></div> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : players.length === 0 ?
        <EmptyState title="Start your club roster" copy="Add the players who turn up each week. You can keep more than one position on every profile." action={<button className="button button-primary" onClick={() => setEditor('new')} data-testid="button-empty-add-player"><Plus size={14} /> Add first player</button>} /> :
          filteredPlayers.length === 0 ? <EmptyState title="No players match that search" copy="Try another player name or playing position." /> :
            <div className="table-wrap"><table className="data-table">
              <thead><tr><th scope="col">Player</th><th scope="col">Positions</th><th scope="col">ELO rating</th><th scope="col" style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>{filteredPlayers.map((player) => <tr key={player.id} data-testid={`row-player-${player.id}`}>
                <td><div className="player-name">{player.name}</div><div className="player-id">PLAYER / {String(player.id).padStart(3, '0')}</div></td>
                <td><div className="tag-list">{player.positions.map((position) => <span className="tag" key={position}>{position}</span>)}</div></td>
                <td className="rating" data-testid={`text-player-elo-${player.id}`}>{player.elo.toLocaleString()}</td>
                <td><div className="row-actions"><button className="button button-quiet" onClick={() => setEditor(player.id)} aria-label={`Edit ${player.name}`} data-testid={`button-edit-player-${player.id}`}><Pencil size={14} /></button><button className="button button-quiet button-danger" onClick={() => removePlayer(player)} aria-label={`Delete ${player.name}`} disabled={deletePlayer.isPending} data-testid={`button-delete-player-${player.id}`}><Trash2 size={15} /></button></div></td>
              </tr>)}</tbody>
            </table></div>}
    </section>
    <Notice text={notice} />
    {editor !== null && <PlayerEditor playerId={editor === 'new' ? null : editor} onClose={() => setEditor(null)} notify={setNotice} />}
  </main></Shell>;
}

function LeaderboardPage() {
  const query = useGetLeaderboard();
  const ranked = [...(query.data ?? [])].sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name));
  const topRating = ranked[0]?.elo ?? 0;
  const average = ranked.length ? Math.round(ranked.reduce((sum, player) => sum + player.elo, 0) / ranked.length) : 0;
  return <Shell><main className="content">
    <PageHeader eyebrow="Ratings / current standings" title="ELO leaderboard" description="A quick read on the club’s current ratings. ELO changes are not applied until match results are supported." />
    <div className="leader-head">
      <div className="leader-feature"><div className="eyebrow">Club standings</div><h2>Every point has a player behind it.</h2><p>Ratings are shown as recorded. New players begin at 1000; this phase does not change ratings after a match.</p></div>
      <div className="leader-stat"><span>Highest rating</span><strong data-testid="text-highest-elo">{query.isLoading ? '—' : topRating.toLocaleString()}</strong><span>Club average <b>{query.isLoading ? '—' : average.toLocaleString()}</b></span></div>
    </div>
    <section className="panel" aria-label="ELO player rankings">
      <div className="panel-head"><div><h2 className="panel-title">Player rankings</h2><div className="panel-note">Sorted by ELO, highest rating first</div></div><span className="panel-note">{ranked.length} {ranked.length === 1 ? 'player' : 'players'}</span></div>
      {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : ranked.length === 0 ?
        <EmptyState title="No ratings to rank yet" copy="Add players to the roster and their current ELO will appear here." action={<Link href="/players" className="button button-primary" data-testid="link-leaderboard-roster">Go to players</Link>} /> :
          <div className="table-wrap"><table className="data-table leaderboard-table">
            <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Positions</th><th scope="col">ELO rating</th></tr></thead>
            <tbody>{ranked.map((player, index) => <tr key={player.id} data-testid={`row-ranking-${player.id}`}>
              <td className="rank-cell"><span className={index < 3 ? 'rank-top' : ''}>{String(index + 1).padStart(2, '0')}</span></td>
              <td><div className="player-name">{player.name}</div><div className="player-id">PLAYER / {String(player.id).padStart(3, '0')}</div></td>
              <td><div className="tag-list">{player.positions.map((position) => <span className="tag" key={position}>{position}</span>)}</div></td>
              <td className="elo-cell"><div className="elo-value"><span>{player.elo.toLocaleString()}</span><span>{topRating > 0 ? Math.round((player.elo / topRating) * 100) : 0}%</span></div><div className="elo-meter"><span style={{ width: `${topRating > 0 ? Math.max(5, (player.elo / topRating) * 100) : 0}%` }} /></div></td>
            </tr>)}</tbody>
          </table></div>}
    </section>
  </main></Shell>;
}

function AssignedPlayer({
  player,
  roleAssignment,
  team,
  swapSelectionId,
  swapSelectionTeam,
  onSelectSwap,
  onRemove,
  onDragStart,
  onDrop,
}: {
  player: Player;
  roleAssignment?: MatchPositionAssignment;
  team: 'A' | 'B';
  swapSelectionId: number | null;
  swapSelectionTeam: 'A' | 'B' | null;
  onSelectSwap: (id: number) => void;
  onRemove: (id: number) => void;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>, id: number) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>, targetId: number) => void;
}) {
  const isSelectedForSwap = swapSelectionId === player.id;
  const isSwapTarget = swapSelectionId !== null && swapSelectionTeam !== team;
  const swapLabel = isSelectedForSwap ? 'Cancel' : isSwapTarget ? 'Swap' : 'Choose';
  return <div
    className="assigned-player"
    draggable
    onDragStart={(event) => onDragStart(event, player.id)}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => onDrop(event, player.id)}
    data-testid={`assigned-player-${player.id}`}
  >
    <div className="assigned-player-copy">
      <strong>{player.name}</strong>
      {roleAssignment ? <div className="assigned-role-line">
        <strong className="assigned-role-name">{roleAssignment.assignedPosition}</strong>
        <RoleBadge assignedPosition={roleAssignment.assignedPosition} status={roleAssignment.assignmentStatus} />
      </div> : <small className="role-pending">Role assigned when both sides are complete</small>}
      <small>Profile: {player.positions.join(' · ')}</small>
      <span className="assigned-elo">ELO {player.elo.toLocaleString()}</span>
    </div>
    <div className="assigned-player-actions">
      <button
        className={`swap-player ${isSelectedForSwap ? 'selected' : ''}`}
        aria-label={isSelectedForSwap ? `Cancel swap for ${player.name}` : isSwapTarget ? `Swap ${player.name} with selected player` : `Choose ${player.name} for swap`}
        aria-pressed={isSelectedForSwap}
        onClick={() => onSelectSwap(player.id)}
        data-testid={`button-swap-player-${player.id}`}
      ><ArrowLeftRight size={12} />{swapLabel}</button>
      <button className="remove-player" aria-label={`Remove ${player.name} from Team ${team}`} onClick={() => onRemove(player.id)} data-testid={`button-unassign-${player.id}`}><X size={14} /></button>
    </div>
  </div>;
}

function RoleBadge({ assignedPosition, status }: { assignedPosition: MatchPosition; status: 'preferred' | 'filled' }) {
  return <span className={`assignment-badge ${status}`} aria-label={`${assignedPosition}: ${status}`}>
    <span aria-hidden="true">{status === 'preferred' ? '✓' : '!'}</span>
    {status === 'preferred' ? 'Preferred' : 'Filled'}
  </span>;
}

function TeamMetrics({ team, players, total }: { team: 'A' | 'B'; players: Player[]; total: number }) {
  const average = players.length ? (total / players.length).toFixed(1) : '—';
  return <div className="team-metrics" data-testid={`summary-team-${team.toLowerCase()}`}>
    <div><span>Total ELO</span><strong data-testid={`text-team-total-elo-${team.toLowerCase()}`}>{total.toLocaleString()}</strong></div>
    <div><span>Average ELO</span><strong data-testid={`text-team-average-elo-${team.toLowerCase()}`}>{average}</strong></div>
  </div>;
}

function MatchDetail({ matchId }: { matchId: number }) {
  const query = useGetMatch(matchId, { query: { queryKey: getGetMatchQueryKey(matchId) } });
  const legacyRoleAssignments = useMemo(() => {
    if (!query.data) return new Map<number, MatchPositionAssignment>();
    try {
      const derived = assignMatchRoles(
        [...query.data.teamA, ...query.data.teamB],
        query.data.teamA.map((player) => player.id),
        query.data.teamB.map((player) => player.id),
      );
      return new Map(
        [...derived.teamAAssignments, ...derived.teamBAssignments]
          .map((assignment) => [assignment.playerId, assignment]),
      );
    } catch {
      return new Map<number, MatchPositionAssignment>();
    }
  }, [query.data]);

  if (query.isLoading) return <div className="state-card">Loading saved roster…</div>;
  if (query.isError || !query.data) return <div className="state-card" role="alert">Roster details could not be loaded. <button className="text-button" onClick={() => void query.refetch()}>Try again</button></div>;
  const renderPlayer = (player: Match['teamA'][number]) => {
    const assignedPosition = player.assignedPosition ?? legacyRoleAssignments.get(player.id)?.assignedPosition;
    if (!assignedPosition) return <p key={player.id}>{player.name} <span>· {player.positions.join(', ')}</span></p>;
    const position = assignedPosition as MatchPosition;
    const status = player.positions.includes(assignedPosition) ? 'preferred' : 'filled';
    return <div className="saved-roster-player" key={player.id}>
      <div><strong>{player.name}</strong><small>Profile: {player.positions.join(' · ')}</small></div>
      <div className="saved-role-info"><strong>{position}</strong><RoleBadge assignedPosition={position} status={status} /></div>
    </div>;
  };
  return <div className="roster-detail">
    <section><h4>Team A · {query.data.teamA.length} players</h4>{query.data.teamA.map(renderPlayer)}</section>
    <section><h4>Team B · {query.data.teamB.length} players</h4>{query.data.teamB.map(renderPlayer)}</section>
  </div>;
}

function MatchCard({ match, expanded, onToggle }: { match: Match; expanded: boolean; onToggle: () => void }) {
  return <article className="panel match-card" data-testid={`card-match-${match.id}`}>
    <div className="match-card-head"><span className="match-label">Roster / {String(match.id).padStart(3, '0')} · {new Date(match.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span className="match-badge">Upcoming</span></div>
    <div className="versus-row"><div className="versus-team">Team A<span>{match.teamA.length} players</span></div><span className="versus-word">VS</span><div className="versus-team">Team B<span>{match.teamB.length} players</span></div></div>
    <div className="match-card-foot"><span>Match roster saved</span><button className="text-button" onClick={onToggle} aria-expanded={expanded} data-testid={`button-view-match-${match.id}`}>{expanded ? 'Hide roster' : 'View roster'} <ChevronDown size={12} style={{ verticalAlign: 'middle', transform: expanded ? 'rotate(180deg)' : undefined }} /></button></div>
    {expanded && <MatchDetail matchId={match.id} />}
  </article>;
}

function MatchesPage() {
  const playersQuery = useListPlayers();
  const matchesQuery = useListMatches();
  const createMatch = useCreateMatch();
  const queryClient = useQueryClient();
  const { notice, setNotice } = useNotice();
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [teamA, setTeamA] = useState<number[]>([]);
  const [teamB, setTeamB] = useState<number[]>([]);
  const [balanceResult, setBalanceResult] = useState<MatchBalanceResult | null>(null);
  const [swapSelectionId, setSwapSelectionId] = useState<number | null>(null);
  const [expandedMatch, setExpandedMatch] = useState<number | null>(null);
  const [createError, setCreateError] = useState('');
  const players = playersQuery.data ?? [];
  const selectedIds = new Set(selectedPlayerIds);
  const selectedPlayers = players.filter((player) => selectedIds.has(player.id));
  const assigned = new Set([...teamA, ...teamB]);
  const unassignedSelected = selectedPlayers.filter((player) => !assigned.has(player.id));
  const teamAPlayers = selectedPlayers.filter((player) => teamA.includes(player.id));
  const teamBPlayers = selectedPlayers.filter((player) => teamB.includes(player.id));
  const roleAssignments = useMemo(() => {
    const selected = players.filter((player) => selectedPlayerIds.includes(player.id));
    if (![12, 13, 14].includes(selected.length)) return null;
    try {
      return assignMatchRoles(selected, teamA, teamB);
    } catch {
      return null;
    }
  }, [players, selectedPlayerIds, teamA, teamB]);
  const roleAssignmentById = new Map(
    roleAssignments
      ? [...roleAssignments.teamAAssignments, ...roleAssignments.teamBAssignments]
        .map((assignment) => [assignment.playerId, assignment])
      : [],
  );
  const total = teamA.length + teamB.length;
  const poolCount = selectedPlayerIds.length;
  const allSelectedAssigned = poolCount === total && selectedPlayerIds.every((id) => assigned.has(id));
  const teamAElo = teamAPlayers.reduce((sum, player) => sum + player.elo, 0);
  const teamBElo = teamBPlayers.reduce((sum, player) => sum + player.elo, 0);
  const eloGap = Math.abs(teamAElo - teamBElo);
  const teamSizesValid = [6, 7].includes(teamA.length) && [6, 7].includes(teamB.length);
  const underdogCoreGetsLibero = roleAssignments?.underdogCoreGetsLibero ?? null;
  let validation = 'Select a pool of 12 to 14 players to begin.';
  let isRosterValid = false;
  if (poolCount < 12 || poolCount > 14) {
    validation = `Select 12 to 14 players (${poolCount} selected).`;
  } else if (!allSelectedAssigned) {
    validation = `Assign all ${poolCount} selected players to Team A or Team B.`;
  } else if (!teamSizesValid) {
    validation = 'Each team must have six or seven players.';
  } else if (!roleAssignments) {
    validation = 'Assign all selected players to teams in a 6/6, 7/6, or 7/7 split.';
  } else if (poolCount === 13 && balanceResult && !underdogCoreGetsLibero) {
    validation = 'Auto-balance could not give the extra Libero role to the lower-ELO six-player core.';
  } else if (poolCount === 13 && !underdogCoreGetsLibero) {
    validation = '13-player roster has the exact role formation, but the seven-player core is not lower ELO.';
    isRosterValid = true;
  } else {
    validation = `${poolCount}-player roster is ready with the exact required role formation.`;
    isRosterValid = true;
  }

  function togglePoolPlayer(playerId: number, checked: boolean) {
    setSelectedPlayerIds((current) => {
      if (checked) {
        if (current.length >= 14 || current.includes(playerId)) return current;
        return [...current, playerId];
      }
      return current.filter((id) => id !== playerId);
    });
    if (!checked) {
      setTeamA((current) => current.filter((id) => id !== playerId));
      setTeamB((current) => current.filter((id) => id !== playerId));
    }
    setBalanceResult(null);
    setSwapSelectionId(null);
    setCreateError('');
  }

  function assign(playerId: number, side: 'A' | 'B') {
    if (!selectedIds.has(playerId) || assigned.has(playerId)) return;
    if (side === 'A' && teamA.length >= 7) return;
    if (side === 'B' && teamB.length >= 7) return;
    if (side === 'A') setTeamA((current) => [...current, playerId]);
    else setTeamB((current) => [...current, playerId]);
    setBalanceResult(null);
    setSwapSelectionId(null);
  }

  function unassign(playerId: number) {
    setTeamA((current) => current.filter((id) => id !== playerId));
    setTeamB((current) => current.filter((id) => id !== playerId));
    setBalanceResult(null);
    setSwapSelectionId(null);
  }

  function swapPlayers(firstId: number, secondId: number) {
    if (firstId === secondId) return;
    const firstIsA = teamA.includes(firstId);
    const secondIsA = teamA.includes(secondId);
    const firstIsB = teamB.includes(firstId);
    const secondIsB = teamB.includes(secondId);
    if (!(firstIsA && secondIsB) && !(firstIsB && secondIsA)) return;
    setTeamA((current) => current.map((id) => id === firstId ? secondId : id === secondId ? firstId : id));
    setTeamB((current) => current.map((id) => id === firstId ? secondId : id === secondId ? firstId : id));
    setBalanceResult(null);
    setSwapSelectionId(null);
  }

  function selectPlayerForSwap(playerId: number) {
    if (swapSelectionId === null || swapSelectionId === playerId) {
      setSwapSelectionId(swapSelectionId === playerId ? null : playerId);
      return;
    }
    const firstSide = teamA.includes(swapSelectionId) ? 'A' : 'B';
    const secondSide = teamA.includes(playerId) ? 'A' : 'B';
    if (firstSide !== secondSide) {
      swapPlayers(swapSelectionId, playerId);
    } else {
      setSwapSelectionId(playerId);
    }
  }

  function handleDragStart(event: ReactDragEvent<HTMLDivElement>, playerId: number) {
    event.dataTransfer.setData('text/plain', String(playerId));
    event.dataTransfer.effectAllowed = 'move';
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>, targetId: number) {
    event.preventDefault();
    const draggedId = Number(event.dataTransfer.getData('text/plain'));
    if (Number.isInteger(draggedId)) swapPlayers(draggedId, targetId);
  }

  function autoBalance() {
    if (poolCount < 12 || poolCount > 14) return;
    const result = balanceMatchTeams(selectedPlayers);
    setTeamA(result.teamAIds);
    setTeamB(result.teamBIds);
    setBalanceResult(result);
    setSwapSelectionId(null);
    setCreateError('');
  }

  function saveMatch() {
    if (!isRosterValid || !roleAssignments ||
      (poolCount === 13 && balanceResult && !balanceResult.underdogCoreGetsLibero)) return;
    setCreateError('');
    createMatch.mutate({ data: {
      teamAPlayerIds: teamA,
      teamBPlayerIds: teamB,
      teamAAssignments: roleAssignments.teamAAssignments.map((assignment) => ({
        playerId: assignment.playerId,
        assignedPosition: apiPositionByRole[assignment.assignedPosition],
      })),
      teamBAssignments: roleAssignments.teamBAssignments.map((assignment) => ({
        playerId: assignment.playerId,
        assignedPosition: apiPositionByRole[assignment.assignedPosition],
      })),
    } }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey() });
        setSelectedPlayerIds([]);
        setTeamA([]);
        setTeamB([]);
        setBalanceResult(null);
        setSwapSelectionId(null);
        setNotice('Upcoming match roster saved.');
      },
      onError: (error) => setCreateError(messageFor(error)),
    });
  }

  return <Shell><main className="content">
    <PageHeader eyebrow="Match day / roster builder" title="Match rosters" description="Choose 12–14 players, assign the exact court roles, then balance teams by ELO or build each side manually." />
    <div className="summary-strip"><span className="summary-num">{matchesQuery.data?.length ?? '—'}</span> saved match rosters <span aria-hidden="true">/</span> assign between 12 and 14 players</div>
    {roleAssignments?.positionShortages.length ? <div className="position-warning" role="alert" data-testid="warning-position-shortage">
      <strong>Some positions were short in this pool</strong>
      <span>{roleAssignments.positionShortages.map((shortage) =>
        `${shortage.position}: ${shortage.filledCount} Filled player${shortage.filledCount === 1 ? '' : 's'}`,
      ).join(' · ')}</span>
      <small>Those slots are still assigned to the highest-ELO available players.</small>
    </div> : null}
    <div className="match-layout">
      <section className="panel builder-panel" aria-label="Build a match roster">
        <div className="panel-head"><div><h2 className="panel-title">Build a match</h2><div className="panel-note">Select a pool first; team assignments can be automatic or manual</div></div><span className="count-chip">{poolCount} / 14 selected</span></div>
        <div className="builder-intro"><strong>Exact role formation</strong><p>Every side gets 1 Setter, 2 Outside Hitters, 2 Middle Blockers, and 1 Opposite. Seven-player sides add 1 Libero. Auto-Balance preserves these roles while reducing the team ELO gap.</p></div>
        <div className="role-legend" aria-label="Role assignment legend">
          <strong>Role badges</strong>
          <RoleBadge assignedPosition="Setter" status="preferred" />
          <RoleBadge assignedPosition="Middle Blocker" status="filled" />
          <span>Preferred means the role is on the player profile; Filled means they covered a role no preferred player could fill.</span>
        </div>
        {playersQuery.isLoading ? <LoadingState lines={3} /> : playersQuery.isError ? <ErrorState error={playersQuery.error} retry={() => void playersQuery.refetch()} /> :
          <>
            <div className="match-mode-switch" role="group" aria-label="Choose match assignment mode">
              <button className={`mode-button ${mode === 'auto' ? 'active' : ''}`} aria-pressed={mode === 'auto'} onClick={() => { setMode('auto'); setBalanceResult(null); }} data-testid="button-mode-auto"><WandSparkles size={14} />Auto-Balance</button>
              <button className={`mode-button ${mode === 'manual' ? 'active' : ''}`} aria-pressed={mode === 'manual'} onClick={() => { setMode('manual'); setBalanceResult(null); }} data-testid="button-mode-manual"><Users size={14} />Manual Assign</button>
            </div>
            <div className="pool-selection">
              <div className="pool-selection-head">
                <div><h3>Select the player pool</h3><p>Choose 12 to 14 players. You can select no more than 14.</p></div>
                <span className="count-chip">{poolCount} selected</span>
              </div>
              {players.length === 0 ? <div className="field-hint pool-empty">No players are on the roster yet. <Link href="/players" className="text-button">Add players first</Link>.</div> :
                <div className="pool-player-list">
                  {players.map((player) => {
                    const checked = selectedIds.has(player.id);
                    return <label className={`pool-player ${checked ? 'selected' : ''}`} key={player.id} data-testid={`pool-player-${player.id}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && poolCount >= 14}
                        onChange={(event) => togglePoolPlayer(player.id, event.currentTarget.checked)}
                        data-testid={`checkbox-pool-player-${player.id}`}
                      />
                      <span className="pool-player-info"><strong>{player.name}</strong><small>{player.positions.join(' · ')}</small></span>
                      <span className="pool-player-elo">ELO {player.elo.toLocaleString()}</span>
                    </label>;
                  })}
                </div>}
              {mode === 'auto' && <div className="pool-actions">
                <button className="button button-primary" onClick={autoBalance} disabled={poolCount < 12 || poolCount > 14} data-testid="button-auto-balance"><WandSparkles size={14} />Auto-Balance Teams</button>
                <button className="button button-quiet" onClick={() => { setSelectedPlayerIds([]); setTeamA([]); setTeamB([]); setBalanceResult(null); setSwapSelectionId(null); }} disabled={poolCount === 0} data-testid="button-clear-pool">Clear selection</button>
              </div>}
            </div>
            {mode === 'manual' && <div className="manual-assign-head"><strong>Manual assignment</strong><span>Use + A or + B for each selected player.</span></div>}
            <div className="team-columns">
              <section className="team-column" aria-label="Team A">
                <div className="team-header"><span className="team-label a">Team A</span><span className={`count-chip ${teamA.length >= 6 && teamA.length <= 7 ? 'ready' : ''}`}>{teamA.length} / 6–7</span></div>
                <TeamMetrics team="A" players={teamAPlayers} total={teamAElo} />
                <div className="assigned-list">{teamAPlayers.length ? teamAPlayers.map((player) => <AssignedPlayer
                  key={player.id}
                  player={player}
                  roleAssignment={roleAssignmentById.get(player.id)}
                  team="A"
                  swapSelectionId={swapSelectionId}
                  swapSelectionTeam={swapSelectionId === null ? null : teamA.includes(swapSelectionId) ? 'A' : 'B'}
                  onSelectSwap={selectPlayerForSwap}
                  onRemove={unassign}
                  onDragStart={handleDragStart}
                  onDrop={handleDrop}
                />) : <div className="field-hint">{mode === 'manual' ? 'Assign selected players here' : 'Run Auto-Balance Teams to build this side'}</div>}</div>
              </section>
              <section className="team-column" aria-label="Team B">
                <div className="team-header"><span className="team-label b">Team B</span><span className={`count-chip ${teamB.length >= 6 && teamB.length <= 7 ? 'ready' : ''}`}>{teamB.length} / 6–7</span></div>
                <TeamMetrics team="B" players={teamBPlayers} total={teamBElo} />
                <div className="assigned-list">{teamBPlayers.length ? teamBPlayers.map((player) => <AssignedPlayer
                  key={player.id}
                  player={player}
                  roleAssignment={roleAssignmentById.get(player.id)}
                  team="B"
                  swapSelectionId={swapSelectionId}
                  swapSelectionTeam={swapSelectionId === null ? null : teamA.includes(swapSelectionId) ? 'A' : 'B'}
                  onSelectSwap={selectPlayerForSwap}
                  onRemove={unassign}
                  onDragStart={handleDragStart}
                  onDrop={handleDrop}
                />) : <div className="field-hint">{mode === 'manual' ? 'Assign selected players here' : 'Run Auto-Balance Teams to build this side'}</div>}</div>
              </section>
            </div>
            <div className="balance-summary" data-testid="summary-elo-gap">
              <span>Team ELO difference</span><strong>{eloGap.toLocaleString()}</strong>
              <small>Team A total {teamAElo.toLocaleString()} · Team B total {teamBElo.toLocaleString()}</small>
            </div>
            {balanceResult && <div className={`balance-feedback ${balanceResult.positionShortages.length ? 'warning' : 'complete'}`} role="status" data-testid="status-auto-balance">
              <strong>Exact role slots assigned</strong>
              <span>Team ELO gap: {balanceResult.totalEloGap.toLocaleString()}.</span>
              {balanceResult.positionShortages.length === 0 && <span>Every assigned role is Preferred.</span>}
              {poolCount === 13 && !balanceResult.underdogCoreGetsLibero && <span>The lower-ELO six-player core could not receive the extra Libero role.</span>}
            </div>}
            {mode === 'manual' && <div className="available-list">
              <div className="available-head"><span>Selected, unassigned players</span><span>{unassignedSelected.length} unassigned</span></div>
              {unassignedSelected.length === 0 ? <div className="field-hint" style={{ padding: 12 }} data-testid="text-unassigned-state">{poolCount === 0 ? 'Choose a player pool above.' : 'All selected players are assigned to a side.'}</div> : unassignedSelected.map((player) => <div className="available-row" key={player.id} data-testid={`available-player-${player.id}`}>
                <div className="available-info"><strong>{player.name}</strong><span>{player.positions.join(' · ')}{player.positions.includes(Position.Libero) ? ' · Libero eligible' : ''} · ELO {player.elo.toLocaleString()}</span></div>
                <div className="assign-actions"><button className="assign-button" onClick={() => assign(player.id, 'A')} disabled={teamA.length >= 7} data-testid={`button-assign-a-${player.id}`}>+ A</button><button className="assign-button b" onClick={() => assign(player.id, 'B')} disabled={teamB.length >= 7} data-testid={`button-assign-b-${player.id}`}>+ B</button></div>
              </div>)}
            </div>}
            {createError && <div className="form-error" style={{ margin: '0 18px 12px' }} role="alert">{createError}</div>}
            <div className="builder-footer"><div className={`validation-note ${isRosterValid ? 'valid' : ''}`} role="status" data-testid="status-roster-validation">{isRosterValid && <Check size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} />}{validation}</div><button className="button button-primary" onClick={saveMatch} disabled={!isRosterValid || createMatch.isPending} data-testid="button-create-match">{createMatch.isPending ? 'Saving roster…' : 'Save upcoming match'}</button></div>
          </>}
      </section>
      <section>
        <div className="panel-head" style={{ padding: '0 0 13px', border: 0 }}><div><h2 className="panel-title">Saved matches</h2><div className="panel-note">Upcoming rosters at a glance</div></div></div>
        {matchesQuery.isLoading ? <section className="panel"><LoadingState lines={3} /></section> : matchesQuery.isError ? <section className="panel"><ErrorState error={matchesQuery.error} retry={() => void matchesQuery.refetch()} /></section> :
          matchesQuery.data?.length ? <div className="upcoming-list">{matchesQuery.data.map((match) => <MatchCard key={match.id} match={match} expanded={expandedMatch === match.id} onToggle={() => setExpandedMatch(expandedMatch === match.id ? null : match.id)} />)}</div> :
            <section className="panel"><EmptyState title="No match rosters yet" copy="Build two sides on the left and save the first upcoming match." /></section>}
      </section>
    </div>
    <Notice text={notice} />
  </main></Shell>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={PlayersPage} />
    <Route path="/players" component={PlayersPage} />
    <Route path="/matches" component={MatchesPage} />
    <Route path="/leaderboard" component={LeaderboardPage} />
    <Route component={NotFound} />
  </Switch></RoutedErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;