import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
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
import { CalendarDays, Check, ChevronDown, Pencil, Plus, Search, Trophy, Trash2, Users, X } from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const positions: PositionType[] = [
  Position.Setter,
  Position.Outside_Hitter,
  Position.Middle_Blocker,
  Position.Opposite,
  Position.Libero,
];

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

function AssignedPlayer({ player, team, remove }: { player: Player; team: 'A' | 'B'; remove: (id: number) => void }) {
  return <div className="assigned-player" data-testid={`assigned-player-${player.id}`}><span>{player.name}<small>{player.positions.join(' · ')}</small></span><button className="remove-player" aria-label={`Remove ${player.name} from Team ${team}`} onClick={() => remove(player.id)} data-testid={`button-unassign-${player.id}`}><X size={14} /></button></div>;
}

function MatchDetail({ matchId }: { matchId: number }) {
  const query = useGetMatch(matchId, { query: { queryKey: getGetMatchQueryKey(matchId) } });
  if (query.isLoading) return <div className="state-card">Loading saved roster…</div>;
  if (query.isError || !query.data) return <div className="state-card" role="alert">Roster details could not be loaded. <button className="text-button" onClick={() => void query.refetch()}>Try again</button></div>;
  return <div className="roster-detail">
    <section><h4>Team A · {query.data.teamA.length} players</h4>{query.data.teamA.map((player) => <p key={player.id}>{player.name} <span>· {player.positions.join(', ')}</span></p>)}</section>
    <section><h4>Team B · {query.data.teamB.length} players</h4>{query.data.teamB.map((player) => <p key={player.id}>{player.name} <span>· {player.positions.join(', ')}</span></p>)}</section>
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
  const [teamA, setTeamA] = useState<number[]>([]);
  const [teamB, setTeamB] = useState<number[]>([]);
  const [expandedMatch, setExpandedMatch] = useState<number | null>(null);
  const [createError, setCreateError] = useState('');
  const players = playersQuery.data ?? [];
  const assigned = new Set([...teamA, ...teamB]);
  const available = players.filter((player) => !assigned.has(player.id));
  const teamAPlayers = players.filter((player) => teamA.includes(player.id));
  const teamBPlayers = players.filter((player) => teamB.includes(player.id));
  const total = teamA.length + teamB.length;
  const liberoA = teamAPlayers.some((player) => player.positions.includes(Position.Libero));
  const liberoB = teamBPlayers.some((player) => player.positions.includes(Position.Libero));
  const teamSizesValid = [6, 7].includes(teamA.length) && [6, 7].includes(teamB.length);
  let validation = 'Build two teams of six or seven players to save this roster.';
  let isRosterValid = false;
  if (teamSizesValid && (total === 12 || total === 14)) {
    validation = `${total} players selected. Ready to save this match roster.`;
    isRosterValid = true;
  } else if (teamA.length === 6 && teamB.length === 7) {
    if (liberoB && !liberoA) { validation = '13-player roster checks out: the seven-player side has a Libero.'; isRosterValid = true; }
    else validation = 'For 13 players, Team B’s seven must include a Libero; Team A’s six must not.';
  } else if (teamA.length === 7 && teamB.length === 6) {
    if (liberoA && !liberoB) { validation = '13-player roster checks out: the seven-player side has a Libero.'; isRosterValid = true; }
    else validation = 'For 13 players, Team A’s seven must include a Libero; Team B’s six must not.';
  }

  function assign(playerId: number, side: 'A' | 'B') {
    if (side === 'A') setTeamA((current) => [...current, playerId]);
    else setTeamB((current) => [...current, playerId]);
  }
  function unassign(playerId: number) {
    setTeamA((current) => current.filter((id) => id !== playerId));
    setTeamB((current) => current.filter((id) => id !== playerId));
  }
  function saveMatch() {
    if (!isRosterValid) return;
    setCreateError('');
    createMatch.mutate({ data: { teamAPlayerIds: teamA, teamBPlayerIds: teamB } }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey() });
        setTeamA([]);
        setTeamB([]);
        setNotice('Upcoming match roster saved.');
      },
      onError: (error) => setCreateError(messageFor(error)),
    });
  }

  return <Shell><main className="content">
    <PageHeader eyebrow="Match day / roster builder" title="Match rosters" description="Set the sides before you head to the court. Roster rules keep every upcoming match ready to play." />
    <div className="summary-strip"><span className="summary-num">{matchesQuery.data?.length ?? '—'}</span> saved match rosters <span aria-hidden="true">/</span> assign between 12 and 14 players</div>
    <div className="match-layout">
      <section className="panel builder-panel" aria-label="Build a match roster">
        <div className="panel-head"><div><h2 className="panel-title">Build a match</h2><div className="panel-note">Assign available players to either side</div></div><span className="count-chip">{total} / 14 selected</span></div>
        <div className="builder-intro"><strong>Roster check</strong><p>Teams must each have 6 or 7 players. A 13-player roster needs a Libero on the seven-player side only.</p></div>
        {playersQuery.isLoading ? <LoadingState lines={3} /> : playersQuery.isError ? <ErrorState error={playersQuery.error} retry={() => void playersQuery.refetch()} /> :
          <>
            <div className="team-columns">
              <section className="team-column" aria-label="Team A">
                <div className="team-header"><span className="team-label a">Team A</span><span className={`count-chip ${teamA.length >= 6 && teamA.length <= 7 ? 'ready' : ''}`}>{teamA.length} / 6–7</span></div>
                <div className="assigned-list">{teamAPlayers.length ? teamAPlayers.map((player) => <AssignedPlayer key={player.id} player={player} team="A" remove={unassign} />) : <div className="field-hint">Add players below</div>}</div>
              </section>
              <section className="team-column" aria-label="Team B">
                <div className="team-header"><span className="team-label b">Team B</span><span className={`count-chip ${teamB.length >= 6 && teamB.length <= 7 ? 'ready' : ''}`}>{teamB.length} / 6–7</span></div>
                <div className="assigned-list">{teamBPlayers.length ? teamBPlayers.map((player) => <AssignedPlayer key={player.id} player={player} team="B" remove={unassign} />) : <div className="field-hint">Add players below</div>}</div>
              </section>
            </div>
            <div className="available-list">
              <div className="available-head"><span>Available players</span><span>{available.length} unassigned</span></div>
              {available.length === 0 ? <div className="field-hint" style={{ padding: 12 }} data-testid="text-available-player-state">{players.length === 0 ? <>No players are on the roster yet. <Link href="/players" className="text-button">Add players first</Link>.</> : 'All available players are assigned to a side.'}</div> : available.map((player) => <div className="available-row" key={player.id} data-testid={`available-player-${player.id}`}>
                <div className="available-info"><strong>{player.name}</strong><span>{player.positions.join(' · ')}{player.positions.includes(Position.Libero) ? ' · Libero eligible' : ''}</span></div>
                <div className="assign-actions"><button className="assign-button" onClick={() => assign(player.id, 'A')} disabled={teamA.length >= 7 || total >= 14} data-testid={`button-assign-a-${player.id}`}>+ A</button><button className="assign-button b" onClick={() => assign(player.id, 'B')} disabled={teamB.length >= 7 || total >= 14} data-testid={`button-assign-b-${player.id}`}>+ B</button></div>
              </div>)}
            </div>
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