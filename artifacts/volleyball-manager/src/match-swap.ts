import type { MatchLock } from './match-balancing.ts';

export function getManualSwapCandidates(
  playerId: number,
  teamAIds: readonly number[],
  teamBIds: readonly number[],
  locks: readonly MatchLock[],
): number[] {
  const isOnA = teamAIds.includes(playerId);
  const isOnB = teamBIds.includes(playerId);
  if (isOnA === isOnB) return [];

  const selectedLock = locks.find((lock) => lock.playerId === playerId);
  const oppositeTeam = isOnA ? teamBIds : teamAIds;
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
): { teamA: number[]; teamB: number[]; locks: MatchLock[] } | null {
  if (!getManualSwapCandidates(firstId, teamAIds, teamBIds, locks).includes(secondId)) return null;

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
