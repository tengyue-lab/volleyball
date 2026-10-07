import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { DragEvent as ReactDragEvent, FormEvent, ReactNode } from 'react';
import { Redirect } from 'wouter';
import { useClerk } from '@clerk/react';
import { AuthBridge, isRatedPlayer, useAccess } from '@/auth';
import type { RatedPlayer } from '@/auth';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Position,
  useCreateMatch,
  useDeleteMatchDraft,
  useUpdateMatchDraft,
  useGetAuthViewer,
  useGrantAdminAccess,
  useListAdminAccess,
  useListAdminAccounts,
  useRevokeAdminAccess,
  useUpdateAccountLink,
  useCreatePlayer,
  useDeletePlayer,
  useGetLeaderboard,
  useGetMatch,
  useGetPlayer,
  useListMatches,
  useListPlayers,
  useReopenMatchResult,
  useSubmitMatchResult,
  useUpdatePlayer,
  getGetLeaderboardQueryKey,
  getGetMatchQueryKey,
  getGetPlayerQueryKey,
  getGetPlayerEloHistoryQueryKey,
  getListMatchesQueryKey,
  getListPlayersQueryKey,
} from '@workspace/api-client-react';
import type { Match, Player, PlayerInput, PlayerUpdate, Position as PositionType } from '@workspace/api-client-react';
import { ArrowLeftRight, LogIn, LogOut, ShieldCheck, UserRound, CalendarDays, Check, ChevronDown, ClipboardList, Menu, Pencil, Plus, Search, Trophy, Trash2, Users, WandSparkles, X } from 'lucide-react';
import { Link, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { toast } from '@/hooks/use-toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  assignMatchRoles,
  balanceMatchTeams,
  balanceAssignedTeams,
  fillMatchTeams,
  validateMatchLocks,
  type MatchLock,
  type MatchBalanceResult,
  type MatchPosition,
  type MatchPositionAssignment,
} from '@/match-balancing';
import { ClerkShell } from '@/clerk-shell';
import NotFound from '@/pages/not-found';
import RankedPositionInput from '@/components/RankedPositionInput';
import AssignedPlayer from '@/components/AssignedPlayer';
import { RankBadge, RankTransition } from '@/components/RankBadge';
import ConfirmDialog from '@/components/ConfirmDialog';
import MatchDeleteConfirmation from '@/components/MatchDeleteConfirmation';
import MatchHistoryDetails from '@/components/MatchHistoryDetails';
import SavedRosterSummary, { rosterLabel } from '@/components/SavedRosterSummary';
import { MatchSessionProvider, useMatchSession } from '@/match-session-context';
import { clearDeletedMatchSession, restoreFailedDeletionSession, draftEditable, editSession, freshSession, nextGameSession, reconcileSession, selectionCanContinue, validMatchDate, visiblePool } from '@/match-session';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchInterval: 5000, staleTime: 0, refetchIntervalInBackground: false, retry: 1 } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
function refreshEverything(client: ReturnType<typeof useQueryClient>) { return client.invalidateQueries(); }
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
  const access = useAccess();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navItems = [
    { href: '/current-match', label: 'Current Match', icon: <CalendarDays size={17} strokeWidth={1.8} /> },
    { href: '/create-match', label: 'Create Match', icon: <Plus size={17} strokeWidth={1.8} /> },
    { href: '/players', label: 'Players', icon: <Users size={17} strokeWidth={1.8} /> },
    { href: '/leaderboard', label: 'Leaderboard', icon: <Trophy size={17} strokeWidth={1.8} /> },
    { href: '/match-history', label: 'Match History', icon: <ClipboardList size={17} strokeWidth={1.8} /> },
    ...(access.signedIn
      ? [{ href: '/user-portal', label: 'Profile', icon: <UserRound size={17} strokeWidth={1.8} /> }]
      : [{ href: '/sign-in', label: 'Sign In', icon: <LogIn size={17} strokeWidth={1.8} /> }]),
    ...(access.isAdmin ? [{ href: '/admin', label: 'Admin', icon: <ShieldCheck size={17} strokeWidth={1.8} /> }] : []),
  ];
  const currentTab = navItems.find((item) => item.href === location);
  const currentTabLabel = currentTab?.label ?? (location === '/' ? 'Loading' : 'SIDEOUT');

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => setMenuOpen(false), [location]);

  return (
    <div className="app-shell">
      <div className="main-area">
        <header className="topbar">
          <div className="nav-menu-anchor" ref={menuRef}>
            <button
              ref={menuButtonRef}
              type="button"
              className="nav-menu-trigger"
              aria-label={`${menuOpen ? 'Close' : 'Open'} navigation menu`}
              aria-expanded={menuOpen}
              aria-controls="section-navigation"
              data-testid="button-menu-toggle"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Menu size={20} strokeWidth={2} aria-hidden="true" />
              <span data-testid="text-current-tab">{currentTabLabel}</span>
              <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            {menuOpen && <nav id="section-navigation" className="nav-menu-panel" aria-label="Main navigation" data-testid="menu-navigation">
              {navItems.map((item) => <Link
                key={item.href}
                href={item.href}
                aria-current={item.href === location ? 'page' : undefined}
                className={`nav-menu-link ${item.href === location ? 'active' : ''}`}
                data-testid={`link-tab-${item.href.slice(1)}`}
                onClick={() => setMenuOpen(false)}
              >
                {item.icon}<span>{item.label}</span>
              </Link>)}
            </nav>}
          </div>
          <Link href="/" className="brand topbar-brand" data-testid="link-brand" aria-label="SIDEOUT home">
            <span className="brand-mark" aria-hidden="true" />
            <span><span className="brand-name">SIDEOUT</span><span className="brand-sub">CLUB ROSTER</span></span>
          </Link>
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
  const access = useAccess();
  const ownerOnly = !access.isAdmin;
  const playerQuery = useGetPlayer(playerId ?? 0, {
    query: { queryKey: getGetPlayerQueryKey(playerId ?? 0), enabled: playerId !== null, refetchInterval: false, refetchOnWindowFocus: false, staleTime: Infinity },
  });
  const createPlayer = useCreatePlayer();
  const updatePlayer = useUpdatePlayer();
  const [name, setName] = useState('');
  const [elo, setElo] = useState('800');
  const [eloPublic, setEloPublic] = useState(true);
  const [selectedPositions, setSelectedPositions] = useState<PositionType[]>([]);
  const [formError, setFormError] = useState('');
  const initializedFor = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (initializedFor.current === playerId) return;
    if (playerId !== null && playerQuery.data) {
      initializedFor.current = playerId;
      setName(playerQuery.data.name);
      setElo(playerQuery.data.elo === null ? '' : String(playerQuery.data.elo));
      setEloPublic(playerQuery.data.eloPublic);
      setSelectedPositions(playerQuery.data.positions);
    }
    if (playerId === null) {
      initializedFor.current = null;
      setName('');
      setElo('800');
      setEloPublic(false);
      setSelectedPositions([]);
    }
  }, [playerId, playerQuery.data]);

  const saving = createPlayer.isPending || updatePlayer.isPending;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    if (playerId !== null && ownerOnly) {
      const data: PlayerUpdate = { eloPublic };
      updatePlayer.mutate({ playerId, data }, {
        onSuccess: async () => { await refreshEverything(queryClient); notify('Your ELO visibility was saved.'); onClose(); },
        onError: (error) => setFormError(messageFor(error)),
      });
      return;
    }
    if (!access.isAdmin) return;
    const cleanName = name.trim();
    const rating = Number(elo);
    if (!cleanName || cleanName.length > 80) return setFormError('Enter a name between 1 and 80 characters.');
    if (selectedPositions.length < 1 || selectedPositions.length > 5 || new Set(selectedPositions).size !== selectedPositions.length) return setFormError('Rank between 1 and 5 unique playing positions.');
    if (!elo.trim() || !Number.isInteger(rating) || rating < 0) return setFormError('ELO must be a whole number of zero or higher.');
    if (playerId === null) {
      const data: PlayerInput = { name: cleanName, positions: selectedPositions, elo: rating, eloPublic };
      createPlayer.mutate({ data }, {
        onSuccess: async () => { await refreshEverything(queryClient); notify(`${cleanName} added to the roster.`); onClose(); },
        onError: (error) => setFormError(messageFor(error)),
      });
    } else {
      const data: PlayerUpdate = { name: cleanName, positions: selectedPositions, elo: rating, eloPublic };
      updatePlayer.mutate({ playerId, data }, {
        onSuccess: async () => { await refreshEverything(queryClient); notify(`${cleanName}'s player details saved.`); onClose(); },
        onError: (error) => setFormError(messageFor(error)),
      });
    }
  }

  const visibility = <div className="form-field visibility-field"><label className="check-row" htmlFor="player-elo-public"><input id="player-elo-public" type="checkbox" checked={eloPublic} onChange={(event) => setEloPublic(event.target.checked)} data-testid="checkbox-elo-public" /><span>Show my ELO on the public leaderboard.</span></label><div className="field-hint">Only the top ten public ratings are listed. You always see your own rating.</div></div>;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="player-dialog-title">
        <div className="modal-head">
          <div><h2 id="player-dialog-title">{playerId === null ? 'Add a player' : ownerOnly ? 'ELO visibility' : 'Edit player'}</h2><p>{playerId === null ? 'Add someone to the club roster.' : ownerOnly ? 'Choose whether your rating appears publicly.' : 'Update this player’s roster details.'}</p></div>
          <button className="button button-quiet" onClick={onClose} aria-label="Close dialog" data-testid="button-close-player"><X size={17} /></button>
        </div>
        {playerId !== null && playerQuery.isLoading ? <div className="modal-body"><LoadingState lines={2} /></div> :
          playerId !== null && playerQuery.isError ? <div className="modal-body"><ErrorState error={playerQuery.error} retry={() => void playerQuery.refetch()} /></div> :
            ownerOnly ? <form className="modal-body" onSubmit={submit}>
              <div className="form-field"><span className="field-label">{name}</span><div className="rating" data-testid="text-own-elo">Your ELO: {playerQuery.data?.elo === null || playerQuery.data?.elo === undefined ? 'Private' : playerQuery.data.elo.toLocaleString()}</div></div>
              {visibility}
              {formError && <div className="form-error" role="alert">{formError}</div>}
              <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} data-testid="button-cancel-player">Cancel</button><button className="button button-primary" type="submit" disabled={saving} data-testid="button-save-player">{saving ? 'Saving…' : 'Save visibility'}</button></div>
            </form> :
            <form className="modal-body" onSubmit={submit}>
              <div className="form-field"><label htmlFor="player-name">Player name</label><input id="player-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus placeholder="e.g. Jordan Lee" data-testid="input-player-name" /></div>
              <div className="form-field"><label htmlFor="player-elo">{playerId === null ? 'Starting ELO' : 'ELO'}</label><input id="player-elo" type="number" min="0" step="1" value={elo} onChange={(event) => setElo(event.target.value)} data-testid="input-player-elo" /><div className="field-hint">New players start at 800. Ratings can be adjusted here.</div></div>
              {visibility}
              <fieldset className="form-field" style={{ border: 0, padding: 0, marginLeft: 0, marginRight: 0 }}>
                <legend className="field-label">Ranked position preferences</legend>
                {playerQuery.data && !playerQuery.data.preferencesConfirmed && <p className="form-error">Legacy preferences are unranked. Choose at least one, review the order, then save to confirm.</p>}
                {playerQuery.data?.preferredRolePriority && <p className="priority-indicator">Priority: Preferred role next match</p>}
                <RankedPositionInput value={selectedPositions} onChange={(value) => { setSelectedPositions(value); setFormError(''); }} />
              </fieldset>
              {formError && <div className="form-error" role="alert">{formError}</div>}
              <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} data-testid="button-cancel-player">Cancel</button><button className="button button-primary" type="submit" disabled={saving} data-testid="button-save-player">{saving ? 'Saving…' : playerId === null ? 'Add player' : 'Save changes'}</button></div>
            </form>}
      </section>
    </div>
  );
}

function PlayersPage() {
  const access = useAccess();
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
        await refreshEverything(queryClient);
        setNotice(`${player.name} removed from the roster.`);
      },
      onError: (error) => setDeleteError(messageFor(error)),
    });
  }

  return <Shell><main className="content">
    <PageHeader eyebrow="Roster / all players" title="Players" description="Your club roster, all in one place. Keep positions and ratings current for the next match.">
      {access.isAdmin && <button className="button button-primary" onClick={() => setEditor('new')} data-testid="button-add-player"><Plus size={15} /> Add player</button>}
    </PageHeader>
    <div className="summary-strip"><span className="summary-num" data-testid="text-player-count">{players.length.toString().padStart(2, '0')}</span> players on roster <span aria-hidden="true">/</span> ELO ratings update after completed results</div>
    <section className="panel" aria-label="Player roster">
      <div className="panel-head">
        <div><h2 className="panel-title">Club roster</h2><div className="panel-note">Player profiles, playing positions and current rating</div></div>
        <div className="table-toolbar"><label className="search"><span className="search-icon"><Search size={13} /></span><input type="search" aria-label="Search players" placeholder="Search roster" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-search-players" /></label></div>
      </div>
      {deleteError && <div className="form-error" role="alert" style={{ margin: 12 }}>{deleteError}</div>}
      {query.isLoading ? <div><LoadingState /></div> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : players.length === 0 ?
        <EmptyState title="Start your club roster" copy="Add the players who turn up each week. You can keep more than one position on every profile." action={access.isAdmin ? <button className="button button-primary" onClick={() => setEditor('new')} data-testid="button-empty-add-player"><Plus size={14} /> Add first player</button> : undefined} /> :
          filteredPlayers.length === 0 ? <EmptyState title="No players match that search" copy="Try another player name or playing position." /> :
            <div className="table-wrap"><table className="data-table" role="table" aria-label="Player roster">
              <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Player</th><th role="columnheader" scope="col">Positions</th><th role="columnheader" scope="col">ELO rating</th>{access.isAdmin && <th role="columnheader" scope="col" style={{ textAlign: 'right' }}>Actions</th>}</tr></thead>
              <tbody role="rowgroup">{filteredPlayers.map((player) => <tr role="row" key={player.id} data-testid={`row-player-${player.id}`}>
                <td role="cell" data-label="Player"><div className="player-name">{player.name}</div><div className="player-id">PLAYER / {String(player.id).padStart(3, '0')}</div>{player.preferredRolePriority && <div className="priority-indicator">Priority: Preferred role next match</div>}</td>
                <td role="cell" data-label="Positions">{!player.preferencesConfirmed && <div className="legacy-indicator">Confirm preferences before next match</div>}<div className="tag-list">{player.positions.map((position, index) => <span className="tag" key={position}>{player.preferencesConfirmed ? `${index + 1}. ` : ''}{position}</span>)}</div></td>
                <td role="cell" data-label="ELO rating" className="rating" data-testid={`text-player-elo-${player.id}`}>{player.elo === null ? <span className="private-rating">Private</span> : player.elo.toLocaleString()}</td>
                {access.isAdmin && <td role="cell" data-label="Actions"><div className="row-actions"><button className="button button-quiet" onClick={() => setEditor(player.id)} aria-label={`Edit ${player.name}`} data-testid={`button-edit-player-${player.id}`}><Pencil size={14} /></button><button className="button button-quiet button-danger" onClick={() => removePlayer(player)} aria-label={`Delete ${player.name}`} disabled={deletePlayer.isPending} data-testid={`button-delete-player-${player.id}`}><Trash2 size={15} /></button></div></td>}
              </tr>)}</tbody>
            </table></div>}
    </section>
    <Notice text={notice} />
    {editor !== null && <PlayerEditor playerId={editor === 'new' ? null : editor} onClose={() => setEditor(null)} notify={setNotice} />}
  </main></Shell>;
}

function LeaderboardPage() {
  const query = useGetLeaderboard();
  const ranked = (query.data ?? []).filter(isRatedPlayer);
  const topRating = ranked[0]?.elo ?? 0;
  const average = ranked.length ? Math.round(ranked.reduce((sum, player) => sum + player.elo, 0) / ranked.length) : 0;
  return <Shell><main className="content">
    <PageHeader eyebrow="Ratings / public top ten" title="ELO leaderboard" description="Players who chose to share their rating, highest first." />
    <div className="leader-head">
      <div className="leader-feature"><div className="eyebrow">Club standings</div><h2>Every point has a player behind it.</h2><p>Players control whether their rating is public. Only the public top ten is listed.</p></div>
      <div className="leader-stat"><span>Highest rating</span><strong data-testid="text-highest-elo">{query.isLoading || !ranked.length ? '—' : topRating.toLocaleString()}</strong><span>Public average <b>{query.isLoading || !ranked.length ? '—' : average.toLocaleString()}</b></span></div>
    </div>
    <section className="panel" aria-label="ELO player rankings">
      <div className="panel-head"><div><h2 className="panel-title">Player rankings</h2><div className="panel-note">Public ratings, highest first</div></div><span className="panel-note">{ranked.length} {ranked.length === 1 ? 'player' : 'players'}</span></div>
      {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : ranked.length === 0 ?
        <EmptyState title="No public players yet." copy="Players can choose to show their ELO from their profile." /> :
          <div className="table-wrap"><table className="data-table leaderboard-table" role="table" aria-label="Public player rankings">
            <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Rank</th><th role="columnheader" scope="col">Player</th><th role="columnheader" scope="col">Top preference</th><th role="columnheader" scope="col">ELO rating</th></tr></thead>
            <tbody role="rowgroup">{ranked.map((player, index) => <tr role="row" key={player.id} data-testid={`row-ranking-${player.id}`}>
              <td role="cell" data-label="Rank" className="rank-cell"><span className={index < 3 ? 'rank-top' : ''}>{index + 1}</span></td>
              <td role="cell" data-label="Player"><div className="player-name">{player.name}</div></td>
              <td role="cell" data-label="Top preference"><div className="tag-list">{player.positions[0] && <span className="tag">{player.positions[0]}</span>}</div></td>
              <td role="cell" data-label="ELO rating" className="elo-cell"><div className="leader-rank-text"><RankBadge rank={player.rank} rating={player.elo} provisional={player.provisional} testId={`badge-rank-${player.id}`} /></div><div className="elo-meter"><span style={{ width: `${topRating > 0 ? Math.max(5, (player.elo / topRating) * 100) : 0}%` }} /></div></td>
            </tr>)}</tbody>
          </table></div>}
    </section>
  </main></Shell>;
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

async function refreshAfterMatchUpdate(queryClient: ReturnType<typeof useQueryClient>, matchId: number, updated: Match) {
  queryClient.setQueryData(getGetMatchQueryKey(matchId), updated);
  await Promise.all([
    refreshEverything(queryClient),
    queryClient.invalidateQueries({ queryKey: getGetMatchQueryKey(matchId) }),
    queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getGetLeaderboardQueryKey() }),
    ...[...updated.teamA, ...updated.teamB].flatMap((player) => [
      queryClient.invalidateQueries({ queryKey: getGetPlayerQueryKey(player.id) }),
      queryClient.invalidateQueries({ queryKey: getGetPlayerEloHistoryQueryKey(player.id) }),
    ]),
  ]);
}

function EditResultButton({ matchId }: { matchId: number }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const reopen = useReopenMatchResult();
  const [error, setError] = useState('');
  return <div className="history-actions">
    <button className="button button-secondary touch-44" disabled={reopen.isPending} data-testid={`button-edit-result-${matchId}`} onClick={() => {
      setError('');
      reopen.mutate({ matchId }, {
        onSuccess: async (updated) => { await refreshAfterMatchUpdate(queryClient, matchId, updated); navigate(`/current-match?match=${updated.id}`); },
        onError: (e) => setError(messageFor(e)),
      });
    }}><Pencil size={14} />{reopen.isPending ? 'Reopening…' : 'Edit result'}</button>
    {error && <div className="form-error" role="alert">{error}</div>}
  </div>;
}

function MatchDetail({ matchId }: { matchId: number }) {
  const [, navigate] = useLocation();
  const { isAdmin } = useAccess();
  const query = useGetMatch(matchId, { query: { queryKey: getGetMatchQueryKey(matchId) } });
  const queryClient = useQueryClient();
  const submitResult = useSubmitMatchResult();
  const reopenResult = useReopenMatchResult();
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [resultError, setResultError] = useState('');
  const legacyRoleAssignments = useMemo(() => {
    if (!query.data) return new Map<number, MatchPositionAssignment>();
    const snapshot = [...query.data.teamA, ...query.data.teamB];
    if (snapshot.every((p) => p.assignedPosition)) return new Map<number, MatchPositionAssignment>();
    const rated = snapshot.filter((p): p is typeof p & { elo: number } => typeof p.elo === 'number');
    if (rated.length !== snapshot.length) return new Map<number, MatchPositionAssignment>();
    try {
      const derived = assignMatchRoles(
        rated,
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
  useEffect(() => {
    if (query.data?.status === 'upcoming') {
      setScoreA('');
      setScoreB('');
    }
  }, [query.data?.status]);

  if (query.isLoading) return <div className="state-card">Loading saved roster…</div>;
  if (query.isError || !query.data) return <div className="state-card" role="alert">Roster details could not be loaded. <button className="text-button" onClick={() => void query.refetch()}>Try again</button></div>;
  const match = query.data;
  const onMatchUpdated = (updated: Match) => refreshAfterMatchUpdate(queryClient, matchId, updated);
  function saveResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResultError('');
    const parsedA = Number(scoreA);
    const parsedB = Number(scoreB);
    if (!scoreA.trim() || !scoreB.trim() || !Number.isInteger(parsedA) || !Number.isInteger(parsedB) || parsedA < 0 || parsedB < 0) {
      setResultError('Enter a whole-number set score of zero or higher for both teams.');
      return;
    }
    if (parsedA === parsedB) {
      setResultError('A match cannot end in a tie. Enter the winning set score.');
      return;
    }
    submitResult.mutate({ matchId, data: { scoreA: parsedA, scoreB: parsedB } }, {
      onSuccess: async (updated) => {
        await onMatchUpdated(updated);
        setResultError('');
        navigate(`/match-history?match=${updated.id}`);
      },
      onError: (error) => setResultError(messageFor(error)),
    });
  }
  function editResult() {
    setResultError('');
    reopenResult.mutate({ matchId }, {
      onSuccess: async (updated) => {
        await onMatchUpdated(updated);
        setScoreA('');
        setScoreB('');
        navigate(`/current-match?match=${updated.id}`);
      },
      onError: (error) => setResultError(messageFor(error)),
    });
  }
  const renderPlayer = (player: Match['teamA'][number]) => {
    const assignedPosition = player.assignedPosition ?? legacyRoleAssignments.get(player.id)?.assignedPosition;
    if (!assignedPosition) return <p key={player.id}>{player.name} <span>· {player.positions.join(', ')}</span></p>;
    const position = assignedPosition as MatchPosition;
    const status = player.assignmentStatus ?? (player.positions.includes(assignedPosition) ? 'preferred' : 'filled');
    return <div className="saved-roster-player" key={player.id}>
      <div><strong>{player.name}</strong><small>Profile: {player.positions.join(' · ')}</small></div>
      <div className="saved-role-info"><strong>{position}</strong><RoleBadge assignedPosition={position} status={status} />{player.preferenceRank != null && <small>Rank {player.preferenceRank}</small>}</div>
    </div>;
  };
  return <div className="roster-detail">
    {[...match.teamA, ...match.teamB].some((p) => p.assignmentStatus === 'filled' || (p.assignedPosition && !p.positions.includes(p.assignedPosition))) && <div className="position-warning" role="status"><strong>Filled positions</strong><span>{positions.filter((role) => [...match.teamA, ...match.teamB].some((p) => p.assignedPosition === role && (p.assignmentStatus === 'filled' || !p.positions.includes(role)))).join(' · ')}</span></div>}
    {match.status === 'upcoming' ? !isAdmin ? <p className="field-hint">Result entry is handled by club admins.</p> : <section className="score-entry">
      <h4>Enter final set score</h4>
      <form className="score-form" onSubmit={saveResult}>
        <div className="score-field">
          <label htmlFor={`score-a-${matchId}`}>Team A sets won</label>
          <input id={`score-a-${matchId}`} type="number" min="0" step="1" inputMode="numeric" required value={scoreA} onChange={(event) => setScoreA(event.currentTarget.value)} data-testid={`input-score-a-${matchId}`} />
        </div>
        <div className="score-field">
          <label htmlFor={`score-b-${matchId}`}>Team B sets won</label>
          <input id={`score-b-${matchId}`} type="number" min="0" step="1" inputMode="numeric" required value={scoreB} onChange={(event) => setScoreB(event.currentTarget.value)} data-testid={`input-score-b-${matchId}`} />
        </div>
        <button className="button button-primary" type="submit" disabled={submitResult.isPending || reopenResult.isPending} data-testid={`button-submit-result-${matchId}`}>
          {submitResult.isPending ? 'Saving result…' : 'Submit result'}
        </button>
      </form>
      {resultError && <div className="form-error result-error" role="alert">{resultError}</div>}
    </section> : <section className="match-result">
      <div className="result-heading">
        <div><span className="eyebrow">Final result</span><h4>{match.winner} won</h4><p>{match.completedAt ? `Completed ${new Date(match.completedAt).toLocaleString()}` : 'Completed'}</p></div>
        {isAdmin && <button className="button button-secondary" onClick={editResult} disabled={reopenResult.isPending || submitResult.isPending} data-testid={`button-edit-result-${matchId}`}>
          {reopenResult.isPending ? 'Reopening…' : 'Edit result'}
        </button>}
      </div>
      <div className="final-score"><span>Team A</span><strong>{match.scoreA}</strong><span className="score-divider">–</span><strong>{match.scoreB}</strong><span>Team B</span></div>
      {resultError && <div className="form-error result-error" role="alert">{resultError}</div>}
      {match.eloChanges.length ? <div className="table-wrap result-table-wrap">
        <table className="data-table result-table" role="table" aria-label="Player results and ELO changes">
          <thead role="rowgroup"><tr role="row"><th role="columnheader">Player</th><th role="columnheader">Position played</th><th role="columnheader">Rank</th><th role="columnheader">ELO before</th><th role="columnheader">ELO after</th><th role="columnheader">Change</th></tr></thead>
          <tbody role="rowgroup">{[
            ...match.teamA.map((player) => ({ player, team: 'Team A' })),
            ...match.teamB.map((player) => ({ player, team: 'Team B' })),
          ].map(({ player, team }) => {
            const change = match.eloChanges.find((entry) => entry.playerId === player.id);
            const playedPosition = player.assignedPosition ?? legacyRoleAssignments.get(player.id)?.assignedPosition ?? '—';
            const changeAmount = change?.changeAmount ?? null;
            return <tr role="row" key={`${team}-${player.id}`}>
              <td role="cell" data-label="Player"><strong>{player.name}</strong><small>{team}</small></td>
              <td role="cell" data-label="Position played">{playedPosition}</td>
              <td role="cell" data-label="Rank">{!change ? '—' : change.eloAfter === null && change.eloBefore === null ? 'Private' : <RankTransition before={change.rankBefore} after={change.rankAfter} movement={change.rankMovement} provisional={change.matchesPlayedAfter !== null && change.matchesPlayedAfter < 10} />}</td>
              <td role="cell" data-label="ELO before">{change ? change.eloBefore ?? 'Private' : '—'}</td>
              <td role="cell" data-label="ELO after">{change ? change.eloAfter ?? 'Private' : '—'}</td>
              <td role="cell" data-label="Change" className={changeAmount !== null && changeAmount > 0 ? 'elo-change-positive' : changeAmount !== null && changeAmount < 0 ? 'elo-change-negative' : ''}>{!change ? '—' : changeAmount === null ? 'Private' : `${changeAmount > 0 ? '+' : ''}${changeAmount}`}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="field-hint">ELO change history is unavailable for this match.</p>}
      <Link href="/leaderboard" className="button button-secondary result-leaderboard"><Trophy size={14} />View leaderboard</Link>
    </section>}
    <section><h4>Team A · {match.teamA.length} players</h4>{match.teamA.map(renderPlayer)}</section>
    <section><h4>Team B · {match.teamB.length} players</h4>{match.teamB.map(renderPlayer)}</section>
  </div>;
}

function HistoryDetails({ match }: { match: Match }) {
  const [opened, setOpened] = useState(false);
  const detail = useGetMatch(match.id, { query: { queryKey: getGetMatchQueryKey(match.id), enabled: opened } });
  const eloState = detail.isError ? 'error' : detail.data ? 'ready' : 'loading';
  return <MatchHistoryDetails match={{ ...match, eloChanges: detail.data?.eloChanges ?? [] }} eloState={opened ? eloState : 'ready'} onEloOpen={() => setOpened(true)} onEloRetry={() => void detail.refetch()} />;
}

function useMatchDeletion() {
  const mutation = useDeleteMatchDraft();
  const client = useQueryClient();
  const { draft, setDraft } = useMatchSession();
  async function remove(match: Match, callbacks: { beforeDelete?: () => void; onSuccess: () => void; onError: (error: unknown) => void }) {
    const previous = draft.editingMatchId === match.id ? draft : null;
    // Close live score entry and clear only this roster's local edit state
    // before submitting. A cancelled confirmation never reaches this point.
    flushSync(() => {
      setDraft((current) => clearDeletedMatchSession(current, match.id));
      callbacks.beforeDelete?.();
    });
    try {
      // Await the request directly: clearing a saved edit remounts Create
      // Match, so per-observer mutate callbacks would be lost on unmount.
      await mutation.mutateAsync({ matchId: match.id, params: { expectedStatus: match.status } });
      await client.cancelQueries();
      client.removeQueries({ queryKey: getGetMatchQueryKey(match.id) });
      client.setQueryData<Match[]>(getListMatchesQueryKey(), (current) => current?.filter((row) => row.id !== match.id));
      // Reversal affects public rankings, private profiles, counters and
      // priority as well as the match list and player ELO histories.
      await refreshEverything(client);
      callbacks.onSuccess();
    } catch (error) {
      if (previous) setDraft((current) => restoreFailedDeletionSession(current, previous));
      toast({ title: 'Match was not deleted', description: messageFor(error), variant: 'destructive' });
      callbacks.onError(error);
    }
  }
  return { ...mutation, remove };
}

function DeleteMatchButton({ match, beforeDelete }: { match: Match; beforeDelete: () => void }) {
  const { isAdmin } = useAccess();
  const deletion = useMatchDeletion();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  if (!isAdmin) return null;
  return <>
    <button className="button button-warn touch-44" data-testid={`button-delete-match-${match.id}`} disabled={deletion.isPending} onClick={() => { setError(''); setConfirming(true); }}><Trash2 size={14} />Delete Match</button>
    {confirming && <MatchDeleteConfirmation completed={match.status === 'completed'} pending={deletion.isPending} error={error}
      onCancel={() => setConfirming(false)}
      onConfirm={() => { if (!deletion.isPending) deletion.remove(match, { beforeDelete, onSuccess: () => setConfirming(false), onError: (failure) => setError(messageFor(failure)) }); }}
    />}
  </>;
}

function MatchCard({ match, expanded, onToggle, beforeDelete }: { match: Match; expanded: boolean; onToggle: () => void; beforeDelete: () => void }) {
  const { isAdmin } = useAccess();
  const completed = match.status === 'completed';
  return <article className="panel match-card" data-testid={`card-match-${match.id}`}>
    <div className="match-card-head"><span className="match-label">Roster / {String(match.id).padStart(3, '0')} · {new Date(match.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span className={`match-badge ${completed ? 'completed' : ''}`}>{completed ? 'Completed' : 'Upcoming'}</span></div>
    <div className="versus-row"><div className="versus-team">Team A<span>{match.teamA.length} players</span>{completed && <strong>{match.scoreA}</strong>}</div><span className="versus-word">{completed ? '–' : 'VS'}</span><div className="versus-team">Team B<span>{match.teamB.length} players</span>{completed && <strong>{match.scoreB}</strong>}</div></div>
    <div className="match-card-foot"><span>{completed ? `${match.winner} won` : 'Match roster saved'}</span>{!completed && <button className="text-button" onClick={onToggle} aria-expanded={expanded} data-testid={`button-view-match-${match.id}`}>{expanded ? 'Hide details' : completed ? 'View results' : isAdmin ? 'Enter score' : 'View roster'} <ChevronDown size={12} style={{ verticalAlign: 'middle', transform: expanded ? 'rotate(180deg)' : undefined }} /></button>}</div>
    {completed && <HistoryDetails match={match} />}
    {isAdmin && <div className="history-actions">{completed && <EditResultButton matchId={match.id} />}<DeleteMatchButton match={match} beforeDelete={beforeDelete} /></div>}
    {!completed && expanded && <MatchDetail matchId={match.id} />}
  </article>;
}

function AdminMatchesPage() {
  const { draft, setDraft, startOver, replaceSession } = useMatchSession();
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const playersQuery = useListPlayers();
  const matchesQuery = useListMatches();
  const createMatch = useCreateMatch();
  const updateDraft = useUpdateMatchDraft();
  const deleteDraft = useMatchDeletion();
  const [targetId, setTargetId] = useState<number | null>(draft.editingMatchId);
  const [resetTarget, setResetTarget] = useState<Match | null>(null);
  const [resetError, setResetError] = useState('');
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const queryClient = useQueryClient();
  const { notice, setNotice } = useNotice();
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const selectedPlayerIds = draft.selectedPlayerIds;
  const setSelectedPlayerIds = (value: number[] | ((current: number[]) => number[])) => {
    setDraft((current) => ({ ...current, selectedPlayerIds: typeof value === 'function' ? value(current.selectedPlayerIds) : value }));
  };
  const [poolSearch, setPoolSearch] = useState('');
  const [poolPosition, setPoolPosition] = useState('');
  const [poolSort, setPoolSort] = useState('name');
  const [teamA, setTeamA] = useState<number[]>(() => [...(draft.savedRoster?.teamAIds ?? [])]);
  const [teamB, setTeamB] = useState<number[]>(() => [...(draft.savedRoster?.teamBIds ?? [])]);
  const [balanceResult, setBalanceResult] = useState<MatchBalanceResult | null>(null);
  const [balancedProfiles, setBalancedProfiles] = useState('');
  const [locks, setLocks] = useState<MatchLock[]>([]);
  const [swapSelectionId, setSwapSelectionId] = useState<number | null>(null);
  const [createError, setCreateError] = useState('');
  const players: RatedPlayer[] = (playersQuery.data ?? []).filter(isRatedPlayer);
  const carried = reconcileSession(draft, playersQuery.data ?? []);
  const savedPreferencesUnchanged = draft.sourcePlayers.every((previous) => {
    const current = players.find((player) => player.id === previous.id);
    return current?.preferencesConfirmed
      && JSON.stringify(current.positions) === JSON.stringify(previous.positions);
  });
  const visiblePlayers = visiblePool(players, poolSearch, poolPosition, poolSort);
  useEffect(() => {
    if (!playersQuery.isSuccess) return;
    const existingIds = new Set(playersQuery.data.map((player) => player.id));
    setDraft((current) => {
      const ids = current.selectedPlayerIds.filter((id) => existingIds.has(id));
      return ids.length === current.selectedPlayerIds.length ? current : { ...current, selectedPlayerIds: ids };
    });
    setTeamA((current) => current.some((id) => !existingIds.has(id)) ? current.filter((id) => existingIds.has(id)) : current);
    setTeamB((current) => current.some((id) => !existingIds.has(id)) ? current.filter((id) => existingIds.has(id)) : current);
    setLocks((current) => current.some((lock) => !existingIds.has(lock.playerId)) ? current.filter((lock) => existingIds.has(lock.playerId)) : current);
  }, [playersQuery.data, playersQuery.isSuccess, setDraft]);
  const selectedIds = new Set(selectedPlayerIds);
  const selectedPlayers = players.filter((player) => selectedIds.has(player.id));
  const profilesFingerprint = JSON.stringify(selectedPlayers.map((p) => [p.id,p.positions,p.elo,p.preferencesConfirmed,p.preferredRolePriority,p.prioritySince]));
  const assigned = new Set([...teamA, ...teamB]);
  const unassignedSelected = selectedPlayers.filter((player) => !assigned.has(player.id));
  const teamAPlayers = selectedPlayers.filter((player) => teamA.includes(player.id));
  const teamBPlayers = selectedPlayers.filter((player) => teamB.includes(player.id));
  const lockedIds = new Set(locks.map((lock) => lock.playerId));
  let lockError = '';
  try { validateMatchLocks(selectedPlayers, locks); } catch (error) { lockError = messageFor(error); }
  const roleAssignments = useMemo(() => {
    const selected = players.filter((player) => selectedPlayerIds.includes(player.id));
    if (![12, 13, 14].includes(selected.length)) return null;
    try {
      validateMatchLocks(selected, locks);
      if (locks.some((lock) => !(lock.team === 'A' ? teamA : teamB).includes(lock.playerId))) return null;
      if (balanceResult && balancedProfiles === profilesFingerprint && balanceResult.teamAIds.join(',') === teamA.join(',') && balanceResult.teamBIds.join(',') === teamB.join(',')) return balanceResult;
      const saved = draft.savedRoster;
      if (saved && saved.teamA.length && saved.teamB.length && !locks.length && savedPreferencesUnchanged
        && saved.teamAIds.join(',') === teamA.join(',') && saved.teamBIds.join(',') === teamB.join(',')) {
        const result = assignMatchRoles(selected, teamA, teamB);
        const assignments = [...saved.teamA, ...saved.teamB];
        const filled = assignments.filter((assignment) => assignment.assignmentStatus === 'filled');
        const totalFor = (ids: number[]) => selected.filter((player) => ids.includes(player.id)).reduce((sum, player) => sum + player.elo, 0);
        const seven = teamA.length === 7 ? teamA : teamB;
        const six = teamA.length === 6 ? teamA : teamB;
        const libero = assignments.find((assignment) => seven.includes(assignment.playerId) && assignment.assignedPosition === 'Libero');
        return {
          ...result, teamAAssignments: saved.teamA, teamBAssignments: saved.teamB,
          preferredCount: assignments.length - filled.length,
          positionShortages: positions.flatMap((position) => {
            const filledCount = filled.filter((assignment) => assignment.assignedPosition === position).length;
            return filledCount ? [{ position, filledCount }] : [];
          }),
          underdogCoreGetsLibero: selected.length === 13 && libero
            ? totalFor(seven.filter((id) => id !== libero.playerId)) <= totalFor(six) : null,
        };
      }
      if (mode === 'manual') return null;
      return assignMatchRoles(selected, teamA, teamB);
    } catch {
      return null;
    }
  }, [players, selectedPlayerIds, teamA, teamB, balanceResult, balancedProfiles, profilesFingerprint, mode, locks, draft.savedRoster, savedPreferencesUnchanged]);
  const roleAssignmentById = new Map(
    roleAssignments
      ? [...roleAssignments.teamAAssignments, ...roleAssignments.teamBAssignments]
        .map((assignment) => [assignment.playerId, assignment])
      : [],
  );
  const total = teamA.length + teamB.length;
  const poolCount = selectedPlayers.length;
  const canContinue = selectionCanContinue(selectedPlayers) && validMatchDate(draft.matchDate);
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
  } else if (selectedPlayers.some((player) => !player.preferencesConfirmed)) {
    validation = 'Confirm ranked preferences for every selected player first.';
  } else if (!selectedPlayers.some((player) => player.positions.includes(Position.Setter))) {
    validation = 'Select at least one Setter-capable player.';
  } else if (!allSelectedAssigned) {
    validation = `Assign all ${poolCount} selected players to Team A or Team B.`;
  } else if (!teamSizesValid) {
    validation = 'Each team must have six or seven players.';
  } else if (!roleAssignments) {
    validation = mode === 'manual' ? 'Press Fill to assign the remaining slots around your locks.' : 'Assign all selected players to teams in a 6/6, 7/6, or 7/7 split.';
  } else if (selectedPlayers.some((player) => !player.preferencesConfirmed)) {
    validation = 'Confirm ranked preferences for every selected player first.';
  } else if (!selectedPlayers.some((player) => player.positions.includes(Position.Setter))) {
    validation = 'Select at least one Setter-capable player.';
  } else if (poolCount === 13 && !underdogCoreGetsLibero) {
    validation = '13-player roster has the exact role formation, but the seven-player core is not lower ELO.';
    isRosterValid = true;
  } else {
    validation = `${poolCount}-player roster is ready with the exact required role formation.`;
    isRosterValid = true;
  }

  function togglePoolPlayer(playerId: number, checked: boolean) {
    if (!checked && lockedIds.has(playerId)) {
      setCreateError('Unlock this player before removing them from the selected pool.');
      return;
    }
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
    if (lockedIds.has(playerId)) { setCreateError('Unlock this player before removing them from their team.'); return; }
    setTeamA((current) => current.filter((id) => id !== playerId));
    setTeamB((current) => current.filter((id) => id !== playerId));
    setBalanceResult(null);
    setSwapSelectionId(null);
  }

  function swapPlayers(firstId: number, secondId: number) {
    if (firstId === secondId) return;
    if (lockedIds.has(firstId) || lockedIds.has(secondId)) { setCreateError('Locked players cannot be swapped. Unlock them first.'); setSwapSelectionId(null); return; }
    const firstIsA = teamA.includes(firstId);
    const secondIsA = teamA.includes(secondId);
    const firstIsB = teamB.includes(firstId);
    const secondIsB = teamB.includes(secondId);
    if (!(firstIsA && secondIsB) && !(firstIsB && secondIsA)) return;
    if (!roleAssignments || roleAssignmentById.get(firstId)?.assignedPosition !== roleAssignmentById.get(secondId)?.assignedPosition) {
      setCreateError('Only players assigned the same position can swap. This keeps ranks and exact formations unchanged.');
      setSwapSelectionId(null);
      return;
    }
    const nextA = teamA.map((id) => id === firstId ? secondId : id === secondId ? firstId : id);
    const nextB = teamB.map((id) => id === firstId ? secondId : id === secondId ? firstId : id);
    try {
      const planned = assignMatchRoles(selectedPlayers, nextA, nextB);
      const allRoles = [...roleAssignments.teamAAssignments, ...roleAssignments.teamBAssignments];
      const larger = nextA.length === 7 ? nextA : nextB;
      const smaller = nextA.length === 6 ? nextA : nextB;
      const liberoId = allRoles.find((a) => a.assignedPosition === 'Libero')?.playerId;
      const coreElo = selectedPlayers.filter((p) => larger.includes(p.id) && p.id !== liberoId).reduce((sum,p) => sum+p.elo,0);
      const smallerElo = selectedPlayers.filter((p) => smaller.includes(p.id)).reduce((sum,p) => sum+p.elo,0);
      setBalanceResult({...planned, teamAIds: nextA, teamBIds: nextB,
        teamAAssignments: allRoles.filter((a) => nextA.includes(a.playerId)),
        teamBAssignments: allRoles.filter((a) => nextB.includes(a.playerId)),
        rankCost: roleAssignments.rankCost, specialistCost: roleAssignments.specialistCost, priorityScore: roleAssignments.priorityScore,
        preferredCount: roleAssignments.preferredCount, positionShortages: roleAssignments.positionShortages,
        underdogCoreGetsLibero: poolCount === 13 ? coreElo <= smallerElo : null,
      });
      setBalancedProfiles(profilesFingerprint);
      setTeamA(nextA);
      setTeamB(nextB);
      setCreateError('');
    } catch (error) { setCreateError(messageFor(error)); }
    setSwapSelectionId(null);
  }

  function selectPlayerForSwap(playerId: number) {
    if (lockedIds.has(playerId) || !roleAssignments) return;
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
    if (locks.length) { setCreateError('Clear Locks before switching to automatic balancing.'); return; }
    try {
    const result = balanceMatchTeams(selectedPlayers);
    setTeamA(result.teamAIds);
    setTeamB(result.teamBIds);
    setBalanceResult(result);
    setBalancedProfiles(profilesFingerprint);
    setSwapSelectionId(null);
    setCreateError('');
    } catch (error) { setCreateError(messageFor(error)); }
  }

  function eloBalance() {
    if (!roleAssignments) return;
    try {
      const result = balanceAssignedTeams(selectedPlayers, {...roleAssignments, teamAIds: teamA, teamBIds: teamB}, locks);
      setTeamA(result.teamAIds); setTeamB(result.teamBIds); setBalanceResult(result);
      setBalancedProfiles(profilesFingerprint);
      setSwapSelectionId(null); setCreateError('');
    } catch (error) { setCreateError(messageFor(error)); }
  }

  function lockPlayer(playerId: number, position: MatchPosition): boolean {
    const team = teamA.includes(playerId) ? 'A' : teamB.includes(playerId) ? 'B' : null;
    if (!team) { setCreateError('Place this player on a team before locking a position.'); return false; }
    const nextLocks: MatchLock[] = [...locks.filter((lock) => lock.playerId !== playerId), {playerId,team,position}];
    try {
      validateMatchLocks(selectedPlayers, nextLocks);
      setLocks(nextLocks); setBalanceResult(null); setSwapSelectionId(null); setCreateError('');
      return true;
    } catch (error) { setCreateError(messageFor(error)); return false; }
  }

  function unlockPlayer(playerId: number) {
    setLocks((current) => current.filter((lock) => lock.playerId !== playerId));
    setBalanceResult(null); setSwapSelectionId(null); setCreateError('');
  }

  function clearLocks() {
    setLocks([]); setBalanceResult(null); setSwapSelectionId(null); setCreateError('');
  }

  function changeMode(next: 'auto' | 'manual') {
    if (next === mode) return;
    if (locks.length) { setCreateError('Clear Locks or unlock every player before switching modes.'); return; }
    setMode(next); setBalanceResult(null); setSwapSelectionId(null); setCreateError('');
  }

  function fillManualTeams() {
    try {
      const result = fillMatchTeams(selectedPlayers, locks);
      setTeamA(result.teamAIds); setTeamB(result.teamBIds); setBalanceResult(result);
      setBalancedProfiles(profilesFingerprint); setSwapSelectionId(null); setCreateError('');
    } catch (error) { setCreateError(messageFor(error)); }
  }

  const busy = createMatch.isPending || updateDraft.isPending || deleteDraft.isPending;
  const upcomingRosters = (matchesQuery.data ?? []).filter((m) => m.status === 'upcoming').sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime() || y.id - x.id);
  const effectiveTargetId = upcomingRosters.length === 1 ? upcomingRosters[0].id : upcomingRosters.some((m) => m.id === targetId) ? targetId : null;
  const targetMatch = upcomingRosters.find((m) => m.id === effectiveTargetId) ?? null;
  const nextGame = matchesQuery.isSuccess && playersQuery.isSuccess ? nextGameSession(matchesQuery.data, playersQuery.data, 0) : null;
  const hasDraftState = selectedPlayerIds.length > 0 || teamA.length > 0 || teamB.length > 0 || draft.editingMatchId !== null || draft.step !== 'date';

  function requestStartOver() {
    if (busy) return;
    if (selectedPlayerIds.length > 0) setConfirmStartOver(true);
    else startOver();
  }
  function startNextGame() {
    if (busy || !playersQuery.isSuccess || !matchesQuery.isSuccess) return;
    const fresh = nextGameSession(matchesQuery.data, playersQuery.data, 0);
    if (!fresh) return;
    replaceSession((generation) => ({ ...fresh, generation }));
  }
  function continueTarget() {
    if (busy || !targetMatch || !draftEditable(targetMatch)) return;
    setSummaryError('');
    replaceSession((generation) => editSession(targetMatch, generation));
  }
  function confirmReset() {
    if (!resetTarget || deleteDraft.isPending) return;
    setResetError('');
    deleteDraft.remove(resetTarget, {
      onSuccess: () => {
        setResetTarget(null);
        // A new, unsaved selection can be reset normally. Do not discard an
        // unrelated saved roster being edited while another target is deleted.
        if (draft.editingMatchId === null) startOver();
      },
      onError: (error) => setResetError(messageFor(error)),
    });
  }

  function saveMatch() {
    if (!isRosterValid || !roleAssignments || !canContinue || draft.step !== 'teams' || busy) return;
    setCreateError('');
    const toApi = (list: typeof roleAssignments.teamAAssignments) => list.map((assignment) => ({
      playerId: assignment.playerId,
      assignedPosition: apiPositionByRole[assignment.assignedPosition],
      assignmentStatus: assignment.assignmentStatus,
      preferenceRank: assignment.preferenceRank,
    }));
    const data = {
      matchDate: draft.matchDate,
      teamAPlayerIds: teamA,
      teamBPlayerIds: teamB,
      teamAAssignments: toApi(roleAssignments.teamAAssignments),
      teamBAssignments: toApi(roleAssignments.teamBAssignments),
    };
    const editingId = draft.editingMatchId;
    if (editingId !== null) {
      updateDraft.mutate({ matchId: editingId, data }, {
        onSuccess: async (updated) => {
          queryClient.setQueryData(getGetMatchQueryKey(editingId), updated);
          await queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey() });
          startOver();
        },
        onError: (error) => setCreateError(messageFor(error)),
      });
      return;
    }
    createMatch.mutate({ data }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListMatchesQueryKey() });
        setSelectedPlayerIds([]);
        setTeamA([]);
        setTeamB([]);
        setBalanceResult(null);
        setBalancedProfiles('');
        setLocks([]);
        setSwapSelectionId(null);
        setMode('auto');
        setPoolSearch('');
        setPoolPosition('');
        setPoolSort('name');
        setDraft((current) => freshSession(current.generation));
        setNotice('Upcoming match roster saved.');
      },
      onError: (error) => setCreateError(messageFor(error)),
    });
  }

  return <Shell><main className="content">
    <PageHeader eyebrow="Match day / roster builder" title="Create Match" description="Choose 12–14 players, assign the exact court roles, then balance teams by ELO or build each side manually." />
    <ol className="session-steps" aria-label="Match creation steps">
      {(['date', 'players', 'teams'] as const).map((step, index) => <li key={step} aria-current={draft.step === step ? 'step' : undefined}>{index + 1}. {step === 'date' ? 'Date' : step === 'players' ? 'Players' : 'Teams'}</li>)}
    </ol>
    <div className="summary-strip"><span className="summary-num" data-testid="text-selected-count">Selected: {poolCount} / 12–14</span></div>
    {matchesQuery.isError && <div className="form-error" role="alert">Saved rosters could not be loaded. <button className="text-button" onClick={() => void matchesQuery.refetch()}>Try again</button></div>}
    <SavedRosterSummary rosters={upcomingRosters} targetId={effectiveTargetId} busy={busy} onSelect={setTargetId} onContinue={continueTarget} onReset={() => { if (targetMatch) { setResetError(''); setResetTarget(targetMatch); } }} />
    {summaryError && <div className="form-error" role="alert">{summaryError}</div>}
    {draft.editingMatchId !== null && <div className="position-warning" role="status" data-testid="status-editing-target"><strong>Editing saved {rosterLabel(upcomingRosters.find((m) => m.id === draft.editingMatchId) ?? { id: draft.editingMatchId, createdAt: '', teamA: [], teamB: [] })}</strong><span>Saving updates this roster instead of creating a new one.</span></div>}
    {draft.step === 'date' && draft.editingMatchId === null && nextGame && <div className="pool-actions"><button className="button button-primary touch-44" disabled={busy} onClick={startNextGame} data-testid="button-next-game">Next Game</button></div>}
    <section className="panel session-date" aria-label="Match date">
      <div className="form-field"><label htmlFor="match-date">Match date {draft.step === 'date' ? '· Step 1' : ''}</label><input id="match-date" type="date" required value={draft.matchDate} onChange={(event) => setDraft((current) => ({ ...current, matchDate: event.target.value }))} data-testid="input-match-date" /></div>
      {draft.step === 'date' && <button className="button button-primary" disabled={!validMatchDate(draft.matchDate)} onClick={() => setDraft((current) => ({ ...current, step: 'players' }))} data-testid="button-date-continue">Continue to players</button>}
      {hasDraftState && <button className="button button-secondary start-over-button" disabled={busy} onClick={requestStartOver} data-testid="button-start-over">Start Over</button>}
      {!validMatchDate(draft.matchDate) && <p className="form-error" role="alert">Choose a valid match date before continuing.</p>}
    </section>
    {playersQuery.isSuccess && carried.missing.length > 0 && <div className="position-warning" role="status" data-testid="warning-missing-players"><strong>Some previous players are no longer on the roster</strong><span>{carried.missing.map((player) => player.name).join(' · ')}</span><small>Select replacements to reach 12–14 players.</small></div>}
    {roleAssignments?.positionShortages.length ? <div className="position-warning" role="alert" data-testid="warning-position-shortage">
      <strong>Some positions were short in this pool</strong>
      <span>{roleAssignments.positionShortages.map((shortage) =>
        `${shortage.position}: ${shortage.filledCount} Filled player${shortage.filledCount === 1 ? '' : 's'}`,
      ).join(' · ')}</span>
      <small>Those slots are still assigned to the highest-ELO available players.</small>
    </div> : null}
    <div className="match-builder-layout" hidden={draft.step === 'date'}>
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
              <button className={`mode-button ${mode === 'auto' ? 'active' : ''}`} aria-pressed={mode === 'auto'} onClick={() => changeMode('auto')} data-testid="button-mode-auto"><WandSparkles size={14} />Auto-Balance</button>
              <button className={`mode-button ${mode === 'manual' ? 'active' : ''}`} aria-pressed={mode === 'manual'} onClick={() => changeMode('manual')} data-testid="button-mode-manual"><Users size={14} />Manual Assign</button>
            </div>
            <div className="pool-selection">
              <div className="pool-selection-head">
                <div><h3>Select the player pool · Step 2</h3><p>Choose 12 to 14 players. You can select no more than 14.</p></div>
                <span className="count-chip">{poolCount} selected</span>
              </div>
              <div className="pool-toolbar">
                <label className="search"><span className="search-icon"><Search size={13} /></span><input type="search" aria-label="Search match players" placeholder="Search players" value={poolSearch} onChange={(event) => setPoolSearch(event.target.value)} data-testid="input-pool-search" /></label>
                <select className="select-input" aria-label="Filter match players by position" value={poolPosition} onChange={(event) => setPoolPosition(event.target.value)} data-testid="select-pool-position"><option value="">All positions</option>{positions.map((position) => <option key={position}>{position}</option>)}</select>
                <select className="select-input" aria-label="Sort match players" value={poolSort} onChange={(event) => setPoolSort(event.target.value)} data-testid="select-pool-sort"><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="elo">Highest ELO</option></select>
              </div>
              {players.length === 0 ? <div className="field-hint pool-empty">No players are on the roster yet. <Link href="/players" className="text-button">Add players first</Link>.</div> :
                <div className="pool-player-list">
                  {visiblePlayers.length === 0 && <p className="field-hint">No players match these controls. Your selections are kept.</p>}
                  {visiblePlayers.map((player) => {
                    const checked = selectedIds.has(player.id);
                    return <label className={`pool-player ${checked ? 'selected' : ''}`} key={player.id} data-testid={`pool-player-${player.id}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={(!checked && !player.preferencesConfirmed) || lockedIds.has(player.id) || (!checked && poolCount >= 14)}
                        onChange={(event) => togglePoolPlayer(player.id, event.currentTarget.checked)}
                        data-testid={`checkbox-pool-player-${player.id}`}
                      />
                      <span className="pool-player-info"><strong>{player.name}</strong><small>{player.positions.map((p, i) => player.preferencesConfirmed ? `${i + 1}. ${p}` : p).join(' · ')}</small>{!player.preferencesConfirmed && <small>Confirm preferences in Players first</small>}{player.preferredRolePriority && <small className="priority-indicator">Priority: Preferred role next match</small>}</span>
                      <span className="pool-player-elo">ELO {player.elo.toLocaleString()}</span>
                      {carried.changedIds.has(player.id) && <small className="carried-warning" data-testid={`warning-profile-${player.id}`}>Profile updated since last match.</small>}
                    </label>;
                  })}
                </div>}
              {draft.step === 'teams' && mode === 'auto' && <div className="pool-actions">
                <button className="button button-primary" onClick={autoBalance} disabled={poolCount < 12 || poolCount > 14} data-testid="button-auto-balance"><WandSparkles size={14} />Auto-Balance Teams</button>
                <button className="button button-quiet" onClick={() => { setSelectedPlayerIds([]); setTeamA([]); setTeamB([]); setBalanceResult(null); setSwapSelectionId(null); }} disabled={poolCount === 0} data-testid="button-clear-pool">Clear selection</button>
              </div>}
              {draft.step === 'players' && <div className="pool-actions">
                <button className="button button-primary" disabled={!canContinue} onClick={() => setDraft((current) => ({ ...current, step: 'teams' }))} data-testid="button-players-continue">Continue to teams</button>
                <button className="button button-quiet" disabled={poolCount === 0 || locks.length > 0} onClick={() => { setSelectedPlayerIds([]); setTeamA([]); setTeamB([]); setBalanceResult(null); setSwapSelectionId(null); }} data-testid="button-clear-pool">Clear selection</button>
                {!canContinue && <small>Select 12–14 players with confirmed preferences, including at least one Setter, and a valid date.</small>}
              </div>}
            </div>
            <div hidden={draft.step !== 'teams'}>
            <div className="pool-actions"><button className="button button-secondary" onClick={() => setDraft((current) => ({ ...current, step: 'players' }))} data-testid="button-back-players">Back to players</button></div>
            <div className="pool-actions"><button className="button button-secondary" disabled={!isRosterValid} onClick={eloBalance} data-testid="button-elo-balance"><ArrowLeftRight size={14} />ELO Balancer</button><small>Same-position swaps only; assigned ranks stay fixed.</small></div>
            {mode === 'manual' && <>
              <div className="manual-assign-head"><strong>Manual assignment</strong><span>Place players with + A / + B and lock preferred roles. Fill may move any unlocked player.</span></div>
              <div className="pool-actions">
                <button className="button button-primary" onClick={fillManualTeams} data-testid="button-fill"><WandSparkles size={14} />Fill</button>
                <button className="button button-secondary" onClick={clearLocks} disabled={!locks.length} data-testid="button-clear-locks">Clear Locks</button>
                <small>{locks.length} locked · locked teams and positions stay fixed</small>
              </div>
              {(lockError || createError) && <div className="position-warning" role="alert" data-testid="warning-manual-locks"><strong>Manual roster needs attention</strong><span>{lockError || createError}</span></div>}
            </>}
            <div className="team-columns">
              <section className="team-column" aria-label="Team A">
                <div className="team-header"><span className="team-label a">Team A</span><span className={`count-chip ${teamA.length >= 6 && teamA.length <= 7 ? 'ready' : ''}`}>{teamA.length} / 6–7</span></div>
                <TeamMetrics team="A" players={teamAPlayers} total={teamAElo} />
                <div className="assigned-list">{teamAPlayers.length ? teamAPlayers.map((player) => <AssignedPlayer
                  key={player.id}
                  player={player}
                  roleAssignment={roleAssignmentById.get(player.id)}
                  manual={mode === 'manual'}
                  lockedPosition={locks.find((lock) => lock.playerId === player.id)?.position}
                  canSwap={mode === 'auto' || !!roleAssignments}
                  onLock={(position) => lockPlayer(player.id, position)}
                  onUnlock={() => unlockPlayer(player.id)}
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
                  manual={mode === 'manual'}
                  lockedPosition={locks.find((lock) => lock.playerId === player.id)?.position}
                  canSwap={mode === 'auto' || !!roleAssignments}
                  onLock={(position) => lockPlayer(player.id, position)}
                  onUnlock={() => unlockPlayer(player.id)}
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
            {balanceResult && roleAssignments && <div className={`balance-feedback ${balanceResult.positionShortages.length ? 'warning' : 'complete'}`} role="status" data-testid="status-auto-balance">
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
            <div className="builder-footer"><div className={`validation-note ${isRosterValid ? 'valid' : ''}`} role="status" data-testid="status-roster-validation">{isRosterValid && <Check size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} />}{validation}</div><button className="button button-primary" onClick={saveMatch} disabled={!isRosterValid || !canContinue || busy} data-testid="button-create-match">{busy ? 'Saving roster…' : draft.editingMatchId !== null ? 'Save changes to roster' : 'Save upcoming match'}</button></div>
            </div>
          </>}
      </section>
    </div>
    <Notice text={notice} />
    {confirmStartOver && <ConfirmDialog testId="dialog-start-over" title="Start over?" tone="warning" confirmLabel="Start Over" onCancel={() => setConfirmStartOver(false)} onConfirm={() => { setConfirmStartOver(false); startOver(); }}><p>This clears the {poolCount} selected {poolCount === 1 ? 'player' : 'players'}, assignments and locks. No saved match is deleted.</p></ConfirmDialog>}
    {resetTarget && <ConfirmDialog testId="dialog-reset-match" title="Reset Current Match?" confirmLabel="Reset Current Match" pendingLabel="Resetting…" pending={deleteDraft.isPending} error={resetError} onCancel={() => setResetTarget(null)} onConfirm={confirmReset}><p><strong>{rosterLabel(resetTarget)}</strong> will be deleted. This cannot be undone.</p></ConfirmDialog>}
  </main></Shell>;
}

function CreateMatchPage() {
  const access = useAccess();
  const { draft } = useMatchSession();
  if (access.isAdmin) return <AdminMatchesPage key={draft.generation} />;
  return <Shell><main className="content">
    <PageHeader eyebrow="Match day / roster builder" title="Create Match" description="Build and balance the sides for an upcoming club match." />
    <section className="panel">
      <EmptyState
        title="Match creation is for club admins"
        copy="You can view upcoming rosters and completed results. A club admin can create or update a match."
        action={<Link href="/current-match" className="button button-secondary">View Current Match</Link>}
      />
    </section>
  </main></Shell>;
}

function MatchCollectionPage({ type }: { type: 'current' | 'history' }) {
  const matchesQuery = useListMatches();
  const search = useSearch();
  const requestedMatchId = Number(new URLSearchParams(search).get('match'));
  const initialMatchId = Number.isInteger(requestedMatchId) && requestedMatchId > 0 ? requestedMatchId : null;
  const isCurrent = type === 'current';
  const [, navigate] = useLocation();
  const [expandedMatch, setExpandedMatch] = useState<number | null>(isCurrent ? initialMatchId : null);
  useEffect(() => {
    setExpandedMatch(isCurrent ? initialMatchId : null);
  }, [initialMatchId, isCurrent]);
  const [dismissedResult, setDismissedResult] = useState<number | null>(null);
  const matches = (matchesQuery.data ?? [])
    .filter((match) => match.status === (isCurrent ? 'upcoming' : 'completed'))
    .sort((a, b) => {
      const dateA = new Date(isCurrent ? a.createdAt : a.completedAt ?? a.createdAt).getTime();
      const dateB = new Date(isCurrent ? b.createdAt : b.completedAt ?? b.createdAt).getTime();
      return dateB - dateA || b.id - a.id;
    });
  return <Shell><main className="content">
    <PageHeader
      eyebrow={isCurrent ? 'Match day / upcoming rosters' : 'Match day / completed results'}
      title={isCurrent ? 'Current Match' : 'Match History'}
      description={isCurrent ? 'All saved upcoming match rosters, newest first.' : 'Completed club matches and their results.'}
    />
    {!isCurrent && initialMatchId !== null && dismissedResult !== initialMatchId && (matchesQuery.data ?? []).some((m) => m.id === initialMatchId && m.status === 'completed') && <section className="panel post-save-result" aria-label="Saved match result" data-testid="panel-post-save-result">
      <div className="post-save-head"><div><span className="eyebrow">Result saved</span><h2 className="panel-title">Match Result</h2></div><button className="button button-secondary touch-44" onClick={() => { setDismissedResult(initialMatchId); navigate('/match-history'); }} data-testid="button-dismiss-result"><X size={14} />Dismiss</button></div>
      <MatchDetail matchId={initialMatchId} />
    </section>}
    {matchesQuery.isLoading ? <LoadingState /> : matchesQuery.isError ? <ErrorState error={matchesQuery.error} retry={() => void matchesQuery.refetch()} /> :
      matches.length ? <div className="match-list">{matches.map((match) => <MatchCard key={match.id} match={match} expanded={expandedMatch === match.id} onToggle={() => setExpandedMatch(expandedMatch === match.id ? null : match.id)} beforeDelete={() => {
        if (expandedMatch === match.id) setExpandedMatch(null);
        if (initialMatchId === match.id) {
          setDismissedResult(match.id);
          navigate(isCurrent ? '/current-match' : '/match-history');
        }
      }} />)}</div> :
        <section className="panel"><EmptyState
          title={isCurrent ? 'No upcoming matches yet' : 'No completed matches yet'}
          copy={isCurrent ? 'Saved match rosters will appear here. Start a roster for the next club match.' : 'Completed matches and results will appear here.'}
          action={isCurrent ? <Link href="/create-match" className="button button-primary"><Plus size={15} /> Create Match</Link> : undefined}
        /></section>}
  </main></Shell>;
}

function CurrentMatchPage() {
  return <MatchCollectionPage type="current" />;
}

function MatchHistoryPage() {
  return <MatchCollectionPage type="history" />;
}

function LegacyMatchesRedirect() {
  const access = useAccess();
  return <Redirect to={access.isAdmin ? '/create-match' : '/current-match'} />;
}

function HomeRoute() {
  const matchesQuery = useListMatches();
  if (matchesQuery.isLoading) return <Shell><main className="content"><LoadingState lines={2} /></main></Shell>;
  if (matchesQuery.isError) return <Shell><main className="content"><ErrorState error={matchesQuery.error} retry={() => void matchesQuery.refetch()} /></main></Shell>;
  const hasUpcomingMatch = (matchesQuery.data ?? []).some((match) => match.status === 'upcoming');
  return <Redirect to={hasUpcomingMatch ? '/current-match' : '/create-match'} />;
}

function UserPortalPage() {
  const access = useAccess();
  const { signOut } = useClerk();
  const viewerQuery = useGetAuthViewer();
  const playerQuery = useGetPlayer(access.playerId ?? 0, { query: { queryKey: getGetPlayerQueryKey(access.playerId ?? 0), enabled: access.playerId !== null } });
  const [editing, setEditing] = useState(false);
  const { notice, setNotice } = useNotice();
  const player = playerQuery.data;
  return <Shell><main className="content">
    <PageHeader eyebrow="Account / my profile" title="My profile" description={access.email ? `Signed in as ${access.email}.` : 'Your SIDEOUT account.'}>
      <button type="button" className="button button-secondary" onClick={() => void signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out"><LogOut size={15} /> Sign out</button>
    </PageHeader>
    {access.status === 'error' ? <section className="panel"><ErrorState error={new Error('We could not verify your account.')} retry={access.retry} /></section> :
      access.playerId === null ? <section className="panel"><EmptyState title="Linking needed" copy="Your account is not linked to a club player yet. Ask a club admin to link it to your roster profile." action={<button className="button button-secondary" onClick={() => void viewerQuery.refetch()} data-testid="button-check-link">Check again</button>} /></section> :
        playerQuery.isLoading ? <LoadingState /> : playerQuery.isError || !player ? <section className="panel"><ErrorState error={playerQuery.error} retry={() => void playerQuery.refetch()} /></section> :
          <section className="panel profile-card" data-testid="card-my-profile">
            <div className="panel-head"><div><h2 className="panel-title" data-testid="text-my-name">{player.name}</h2><div className="panel-note">PLAYER / {String(player.id).padStart(3, '0')}</div></div><button className="button button-secondary" onClick={() => setEditing(true)} data-testid="button-edit-visibility"><Pencil size={14} /> ELO visibility</button></div>
            <div className="profile-grid">
              <div><span className="eyebrow">My ELO</span><strong className="profile-elo" data-testid="text-my-elo">{player.elo === null ? 'Private' : player.elo.toLocaleString()}</strong></div>
              <div><span className="eyebrow">Rank</span>{player.elo === null ? <strong>Private</strong> : <RankBadge rank={player.rank} provisional={player.provisional} testId="badge-my-rank" />}</div>
              <div><span className="eyebrow">Matches played</span><strong data-testid="text-my-matches">{player.matchesPlayed}</strong>{player.provisional && <div className="field-hint" data-testid="text-my-placement">Placement: {player.matchesPlayed} / 10 matches.</div>}</div>
              <div><span className="eyebrow">Leaderboard</span><strong data-testid="text-my-visibility">{player.eloPublic ? 'Shown publicly' : 'Hidden'}</strong></div>
              <div><span className="eyebrow">Positions</span><div className="tag-list">{player.positions.map((position, index) => <span className="tag" key={position}>{player.preferencesConfirmed ? `${index + 1}. ` : ''}{position}</span>)}</div></div>
            </div>
          </section>}
    <Notice text={notice} />
    {editing && access.playerId !== null && <PlayerEditor playerId={access.playerId} onClose={() => setEditing(false)} notify={setNotice} />}
  </main></Shell>;
}

function AdminPage() {
  const access = useAccess();
  const queryClient = useQueryClient();
  const accountsQuery = useListAdminAccounts();
  const accessQuery = useListAdminAccess();
  const playersQuery = useListPlayers();
  const linkAccount = useUpdateAccountLink();
  const grant = useGrantAdminAccess();
  const revoke = useRevokeAdminAccess();
  const { notice, setNotice } = useNotice();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  if (!access.isAdmin) return <Redirect to="/" />;
  const players = playersQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const done = (text: string) => async () => { await refreshEverything(queryClient); setError(''); setNotice(text); };
  function link(accountId: string, value: string) {
    linkAccount.mutate({ accountId, data: { playerId: value === '' ? null : Number(value) } }, { onSuccess: done(value === '' ? 'Account unlinked.' : 'Account linked.'), onError: (e) => setError(messageFor(e)) });
  }
  function submitGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes('@')) return setError('Enter a valid email address.');
    grant.mutate({ data: { email: clean } }, { onSuccess: async () => { setEmail(''); await done(`Admin access granted to ${clean}.`)(); }, onError: (e) => setError(messageFor(e)) });
  }
  function revokeAccess(target: string) {
    if (!window.confirm(`Revoke admin access for ${target}?`)) return;
    revoke.mutate({ email: target }, { onSuccess: done(`Admin access revoked for ${target}.`), onError: (e) => setError(messageFor(e)) });
  }
  return <Shell><main className="content">
    <PageHeader eyebrow="Admin / access" title="Admin access" description="Link registered accounts to roster players and manage who can administer the club." />
    {error && <div className="form-error" role="alert" data-testid="text-admin-error">{error}</div>}
    <section className="panel" aria-label="Account links">
      <div className="panel-head"><div><h2 className="panel-title">Account links</h2><div className="panel-note">Each verified account can own one roster player</div></div></div>
      {accountsQuery.isLoading ? <LoadingState /> : accountsQuery.isError ? <ErrorState error={accountsQuery.error} retry={() => void accountsQuery.refetch()} /> : accounts.length === 0 ? <EmptyState title="No registered accounts yet" copy="Accounts appear here after people sign up and verify their email." /> :
        <div className="table-wrap"><table className="data-table" role="table" aria-label="Account links"><thead role="rowgroup"><tr role="row"><th role="columnheader">Account</th><th role="columnheader">Role</th><th role="columnheader">Linked player</th></tr></thead>
          <tbody role="rowgroup">{accounts.map((account) => <tr role="row" key={account.id} data-testid={`row-account-${account.id}`}>
            <td role="cell" data-label="Account"><div className="player-name">{account.email ?? 'No email'}</div></td>
            <td role="cell" data-label="Role">{account.isAdmin ? 'Admin' : 'Member'}</td>
            <td role="cell" data-label="Linked player"><select className="select-input" value={account.playerId ?? ''} disabled={linkAccount.isPending} onChange={(event) => link(account.id, event.target.value)} aria-label={`Linked player for ${account.email ?? account.id}`} data-testid={`select-link-${account.id}`}><option value="">Not linked</option>{players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
          </tr>)}</tbody></table></div>}
    </section>
    <section className="panel" style={{ marginTop: 20 }} aria-label="Admin grants">
      <div className="panel-head"><div><h2 className="panel-title">Admin email access</h2><div className="panel-note">Grant access ahead of sign-up; bootstrap admins cannot be revoked</div></div></div>
      <form className="grant-form" onSubmit={submitGrant}><input type="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} aria-label="Admin email" data-testid="input-admin-email" /><button className="button button-primary" type="submit" disabled={grant.isPending} data-testid="button-grant-admin"><Plus size={14} /> Grant access</button></form>
      {accessQuery.isLoading ? <LoadingState lines={2} /> : accessQuery.isError ? <ErrorState error={accessQuery.error} retry={() => void accessQuery.refetch()} /> : (accessQuery.data ?? []).length === 0 ? <EmptyState title="No admin grants" copy="Grant an email to give someone admin access." /> :
        <div className="table-wrap"><table className="data-table" role="table" aria-label="Admin email access"><thead role="rowgroup"><tr role="row"><th role="columnheader">Email</th><th role="columnheader">Type</th><th role="columnheader" style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody role="rowgroup">{(accessQuery.data ?? []).map((entry) => <tr role="row" key={entry.email} data-testid={`row-grant-${entry.email}`}><td role="cell" data-label="Email"><div className="player-name">{entry.email}</div></td><td role="cell" data-label="Type">{entry.bootstrap ? 'Bootstrap' : 'Granted'}</td>
            <td role="cell" data-label="Actions"><div className="row-actions">{!entry.bootstrap && <button className="button button-quiet button-danger" onClick={() => revokeAccess(entry.email)} disabled={revoke.isPending} aria-label={`Revoke ${entry.email}`} data-testid={`button-revoke-${entry.email}`}><Trash2 size={15} /></button>}</div></td></tr>)}</tbody></table></div>}
    </section>
    <Notice text={notice} />
  </main></Shell>;
}

function SignedInOnly({ children }: { children: ReactNode }) {
  const access = useAccess();
  return access.signedIn ? <>{children}</> : <Redirect to="/" />;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={HomeRoute} />
    <Route path="/current-match" component={CurrentMatchPage} />
    <Route path="/create-match" component={CreateMatchPage} />
    <Route path="/players" component={PlayersPage} />
    <Route path="/leaderboard" component={LeaderboardPage} />
    <Route path="/match-history" component={MatchHistoryPage} />
    <Route path="/matches" component={LegacyMatchesRedirect} />
    <Route path="/user-portal">{() => <SignedInOnly><UserPortalPage /></SignedInOnly>}</Route>
    <Route path="/admin" component={AdminPage} />
    <Route component={NotFound} />
  </Switch></RoutedErrorBoundary>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkShell><QueryClientProvider client={queryClient}><AuthBridge><MatchSessionProvider><TooltipProvider><Router /><Toaster /></TooltipProvider></MatchSessionProvider></AuthBridge></QueryClientProvider></ClerkShell></WouterRouter>;
}

export default App;
