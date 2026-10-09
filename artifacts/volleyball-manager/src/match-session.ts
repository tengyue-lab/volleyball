import type { Match, Player } from '@workspace/api-client-react';
import type { MatchPositionAssignment } from './match-balancing';

export type SessionStep = 'date' | 'players' | 'teams';
export type CarriedPlayer = Pick<Player, 'id' | 'name' | 'positions'> & {
  preferencesConfirmed?: boolean;
};
export interface SavedRoster {
  manualMode?: Match['manualMode'];
  teamAIds: number[];
  teamBIds: number[];
  teamA: MatchPositionAssignment[];
  teamB: MatchPositionAssignment[];
}
export interface MatchSession {
  editingMatchId: number | null;
  savedRoster: SavedRoster | null;
  generation: number;
  step: SessionStep;
  matchDate: string;
  selectedPlayerIds: number[];
  sourcePlayers: CarriedPlayer[];
}

export function updateMatchSessionStep(session: MatchSession, step: SessionStep): MatchSession {
  return { ...session, step };
}

export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function validMatchDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localToday(date) === value;
}

export function freshSession(generation = 0, now = new Date()): MatchSession {
  return { editingMatchId: null, savedRoster: null, generation, step: 'date', matchDate: localToday(now), selectedPlayerIds: [], sourcePlayers: [] };
}

export function clearDeletedMatchSession(session: MatchSession, matchId: number): MatchSession {
  return session.editingMatchId === matchId ? freshSession(session.generation + 1) : session;
}

export function restoreFailedDeletionSession(current: MatchSession, previous: MatchSession): MatchSession {
  // Do not overwrite another roster started while the request was in flight.
  return current.generation === previous.generation + 1
    && current.editingMatchId === null && current.step === 'date'
    && current.selectedPlayerIds.length === 0
    ? { ...previous, generation: current.generation + 1 } : current;
}

export function resultActionsReady(
  match: Pick<Match, 'status' | 'scoreA' | 'scoreB' | 'winner'>,
  saving = false,
  reopening = false,
): boolean {
  return !saving && !reopening && match.status === 'completed'
    && Number.isInteger(match.scoreA) && Number.isInteger(match.scoreB) && !!match.winner;
}

export function nextSession(match: Match, generation: number, now = new Date()): MatchSession {
  if (!resultActionsReady(match)) throw new Error('Save the completed result before starting another match.');
  // Deliberately omit ratings and audit data, and copy nested arrays.
  const sourcePlayers = [...match.teamA, ...match.teamB].map((player) => ({
    id: player.id, name: player.name, positions: [...player.positions],
    preferencesConfirmed: player.preferencesConfirmed,
  }));
  return {
    ...freshSession(generation, now), step: 'players', sourcePlayers,
    selectedPlayerIds: [...new Set(sourcePlayers.map((player) => player.id))],
  };
}

export function reconcileSession(session: MatchSession, players: Player[]) {
  const existing = new Map(players.map((player) => [player.id, player]));
  const selectedPlayerIds = session.selectedPlayerIds.filter((id) => existing.has(id));
  const missing = session.sourcePlayers.filter((player) => !existing.has(player.id));
  const changedIds = new Set(session.sourcePlayers.filter((previous) => {
    const current = existing.get(previous.id);
    return current && (current.name !== previous.name
      || JSON.stringify(current.positions) !== JSON.stringify(previous.positions)
      || (previous.preferencesConfirmed !== undefined && current.preferencesConfirmed !== previous.preferencesConfirmed)
      || !current.preferencesConfirmed);
  }).map((player) => player.id));
  return { selectedPlayerIds, missing, changedIds };
}

export function selectionCanContinue(players: Player[]): boolean {
  return players.length >= 12 && players.length <= 14
    && players.every((player) => player.preferencesConfirmed && typeof player.elo === 'number')
    && players.some((player) => player.positions.includes('Setter'));
}

export function rosterCanContinue(players: Player[]): boolean {
  return players.length >= 12 && players.length <= 14
    && new Set(players.map((player) => player.id)).size === players.length
    && players.every((player) => typeof player.elo === 'number');
}

export function visiblePool<T extends Player>(players: T[], search: string, position: string, sort: string): T[] {
  const filtered = players.filter((player) =>
    `${player.name} ${player.positions.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())
    && (!position || player.positions.includes(position as Player['positions'][number])));
  return filtered.sort((a, b) => {
    const nameOrder = a.name.localeCompare(b.name) || a.id - b.id;
    if (sort === 'elo') return (b.elo ?? 0) - (a.elo ?? 0) || nameOrder;
    return sort === 'name-desc' ? -nameOrder : nameOrder;
  });
}

function completedOrder(a: Match, b: Match): number {
  const at = new Date(a.completedAt ?? a.createdAt).getTime();
  const bt = new Date(b.completedAt ?? b.createdAt).getTime();
  if (at !== bt) return bt - at;
  const ac = new Date(a.createdAt).getTime();
  const bc = new Date(b.createdAt).getTime();
  return bc - ac || b.id - a.id;
}

export function latestCompletedMatch(matches: Match[]): Match | null {
  return matches.filter((match) => match.status === 'completed').sort(completedOrder)[0] ?? null;
}

/** Only the most recent completed match is considered; never falls back to an older one. */
export function nextGameSession(matches: Match[], players: Player[], generation: number, now = new Date()): MatchSession | null {
  const latest = latestCompletedMatch(matches);
  if (!latest) return null;
  const live = new Map(players.map((player) => [player.id, player]));
  const supported = new Set(['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite', 'Libero']);
  const ids = [...new Set([...latest.teamA, ...latest.teamB].map((player) => player.id))].filter((id) => {
    const player = live.get(id);
    return player && player.preferencesConfirmed && typeof player.elo === 'number'
      && player.positions.length >= 1 && player.positions.length <= 5
      && new Set(player.positions).size === player.positions.length
      && player.positions.every((position) => supported.has(position));
  });
  const pool = ids.map((id) => live.get(id)!);
  if (ids.length < 12 || ids.length > 14 || !selectionCanContinue(pool)) return null;
  return {
    ...freshSession(generation, now), step: 'players', selectedPlayerIds: ids,
    sourcePlayers: pool.map((player) => ({ id: player.id, name: player.name, positions: [...player.positions], preferencesConfirmed: player.preferencesConfirmed })),
  };
}

export function draftEditable(match: Pick<Match, 'status' | 'draftEditable'>): boolean {
  return match.status === 'upcoming' && match.draftEditable === true;
}

export function editSession(match: Match, generation: number, now = new Date()): MatchSession {
  if (!draftEditable(match)) throw new Error('This roster is protected and cannot be edited here.');
  const all = [...match.teamA, ...match.teamB];
  const sourcePlayers = all.map((player) => ({
    id: player.id, name: player.name, positions: [...player.positions], preferencesConfirmed: player.preferencesConfirmed,
  }));
  const toAssignments = (team: Match['teamA']): MatchPositionAssignment[] => team.flatMap((player) => player.assignedPosition ? [{
    playerId: player.id, assignedPosition: player.assignedPosition as MatchPositionAssignment['assignedPosition'],
    assignmentStatus: player.assignmentStatus ?? (player.positions.includes(player.assignedPosition) ? 'preferred' : 'filled'),
    preferenceRank: player.preferenceRank ?? null,
  }] : []);
  const teamA = toAssignments(match.teamA);
  const teamB = toAssignments(match.teamB);
  const complete = teamA.length === match.teamA.length && teamB.length === match.teamB.length;
  const matchDate = match.matchDate && validMatchDate(match.matchDate) ? match.matchDate : localToday(now);
  return {
    ...freshSession(generation, now), step: 'teams', matchDate, editingMatchId: match.id, sourcePlayers,
    selectedPlayerIds: [...new Set(all.map((player) => player.id))],
    savedRoster: { manualMode: match.manualMode, teamAIds: match.teamA.map((p) => p.id), teamBIds: match.teamB.map((p) => p.id), teamA: complete ? teamA : [], teamB: complete ? teamB : [] },
  };
}
