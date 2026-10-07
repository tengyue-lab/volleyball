import type { MatchBalanceResult, MatchLock, MatchPosition, MatchRoleAssignments } from './match-balancing.ts';

export function getSameRoleSwapCandidates(
  playerId: number,
  oppositeTeam: readonly number[],
  assignedRoles: ReadonlyMap<number, MatchPosition>,
): number[] {
  const role = assignedRoles.get(playerId);
  return role ? oppositeTeam.filter((id) => assignedRoles.get(id) === role) : [];
}

export function getManualSwapCandidates(
  playerId: number,
  teamAIds: readonly number[],
  teamBIds: readonly number[],
  locks: readonly MatchLock[],
  assignedRoles: ReadonlyMap<number, MatchPosition> = new Map(),
): number[] {
  const isOnA = teamAIds.includes(playerId);
  const isOnB = teamBIds.includes(playerId);
  if (isOnA === isOnB) return [];

  const selectedLock = locks.find((lock) => lock.playerId === playerId);
  const oppositeTeam = isOnA ? teamBIds : teamAIds;
  const selectedRole = assignedRoles.get(playerId);
  if (selectedRole) {
    return getSameRoleSwapCandidates(playerId, oppositeTeam, assignedRoles);
  }
  return oppositeTeam.filter((candidateId) => {
    const candidateLock = locks.find((lock) => lock.playerId === candidateId);
    return selectedLock
      ? candidateLock?.position === selectedLock.position
      : !candidateLock;
  });
}

export function swapManualTeamMembers(
  firstId: number,
  secondId: number,
  teamAIds: readonly number[],
  teamBIds: readonly number[],
  locks: readonly MatchLock[],
  assignedRoles: ReadonlyMap<number, MatchPosition> = new Map(),
): { teamA: number[]; teamB: number[]; locks: MatchLock[] } | null {
  if (!getManualSwapCandidates(firstId, teamAIds, teamBIds, locks, assignedRoles).includes(secondId)) return null;

  const firstTeam = teamAIds.includes(firstId) ? 'A' : 'B';
  const secondTeam = firstTeam === 'A' ? 'B' : 'A';
  return {
    teamA: teamAIds.map((id) => id === firstId ? secondId : id === secondId ? firstId : id),
    teamB: teamBIds.map((id) => id === firstId ? secondId : id === secondId ? firstId : id),
    locks: locks.map((lock) => lock.playerId === firstId
      ? { ...lock, team: secondTeam }
      : lock.playerId === secondId
        ? { ...lock, team: firstTeam }
        : lock),
  };
}

// Move existing role records with their players; never generate new assignments.
export function preserveSwappedRoles(
  roles: MatchRoleAssignments,
  teamAIds: number[],
  teamBIds: number[],
  players: readonly { id: number; elo: number }[],
): MatchBalanceResult {
  const assignments = [...roles.teamAAssignments, ...roles.teamBAssignments];
  const totalFor = (ids: readonly number[]) => players
    .filter((player) => ids.includes(player.id)).reduce((sum, player) => sum + player.elo, 0);
  const seven = teamAIds.length === 7 ? teamAIds : teamBIds;
  const six = teamAIds.length === 6 ? teamAIds : teamBIds;
  const libero = assignments.find((assignment) => assignment.assignedPosition === 'Libero' && seven.includes(assignment.playerId));
  return {
    ...roles,
    teamAIds,
    teamBIds,
    teamAAssignments: assignments.filter((assignment) => teamAIds.includes(assignment.playerId)),
    teamBAssignments: assignments.filter((assignment) => teamBIds.includes(assignment.playerId)),
    totalEloGap: Math.abs(totalFor(teamAIds) - totalFor(teamBIds)),
    underdogCoreGetsLibero: players.length === 13 && libero
      ? totalFor(seven.filter((id) => id !== libero.playerId)) <= totalFor(six) : null,
  };
}
