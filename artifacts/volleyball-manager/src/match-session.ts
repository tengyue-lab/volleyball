import type { Match, Player } from '@workspace/api-client-react';

export type SessionStep = 'date' | 'players' | 'teams';
export type CarriedPlayer = Pick<Player, 'id' | 'name' | 'positions'> & {
  preferencesConfirmed?: boolean;
};
export interface MatchSession {
  generation: number;
  step: SessionStep;
  matchDate: string;
  selectedPlayerIds: number[];
  sourcePlayers: CarriedPlayer[];
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
  return { generation, step: 'date', matchDate: localToday(now), selectedPlayerIds: [], sourcePlayers: [] };
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
