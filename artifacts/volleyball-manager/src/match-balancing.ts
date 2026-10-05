export interface MatchBalancePlayer {
  id: number;
  positions: readonly string[];
  elo: number;
}

export const MATCH_POSITIONS = [
  'Setter',
  'Outside Hitter',
  'Middle Blocker',
  'Opposite',
  'Libero',
] as const;

export type MatchPosition = typeof MATCH_POSITIONS[number];
export type MatchAssignmentStatus = 'preferred' | 'filled';

export interface MatchPositionAssignment {
  playerId: number;
  assignedPosition: MatchPosition;
  assignmentStatus: MatchAssignmentStatus;
}

export interface PositionShortage {
  position: MatchPosition;
  filledCount: number;
}

export interface MatchRoleAssignments {
  teamAAssignments: MatchPositionAssignment[];
  teamBAssignments: MatchPositionAssignment[];
  positionShortages: PositionShortage[];
  preferredCount: number;
  underdogCoreGetsLibero: boolean | null;
  totalEloGap: number;
}

export interface MatchBalanceResult extends MatchRoleAssignments {
  teamAIds: number[];
  teamBIds: number[];
}

interface TeamPlan {
  assignments: MatchPositionAssignment[];
  preferredCount: number;
  filledPlayerElo: number;
}

interface PlanSuffix {
  preferredCount: number;
  filledPlayerElo: number;
  roleIndexes: number[];
}

interface BalanceCandidate extends MatchBalanceResult {
  filledPlayerElo: number;
  underdogRuleViolation: number;
  underdogCoreGap: number;
}

const SIX_PLAYER_COUNTS: Record<MatchPosition, number> = {
  Setter: 1,
  'Outside Hitter': 2,
  'Middle Blocker': 2,
  Opposite: 1,
  Libero: 0,
};

const SEVEN_PLAYER_COUNTS: Record<MatchPosition, number> = {
  ...SIX_PLAYER_COUNTS,
  Libero: 1,
};

function totalElo(players: readonly MatchBalancePlayer[]) {
  return players.reduce((sum, player) => sum + player.elo, 0);
}

function compareRoleIndexes(a: readonly number[], b: readonly number[]) {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/**
 * Assign every player in one team to exactly one required role.
 * Preferred assignments are maximized first. Any remaining slots are filled
 * with the highest-ELO players available, with deterministic ties by role order.
 */
function assignTeamRoles(
  players: readonly MatchBalancePlayer[],
  requiredCounts: Record<MatchPosition, number>,
): TeamPlan {
  const orderedPlayers = [...players].sort((a, b) => a.id - b.id);
  const initialCounts = MATCH_POSITIONS.map((position) => requiredCounts[position]);
  const memo = new Map<string, PlanSuffix | null>();

  function bestPlan(index: number, remaining: number[]): PlanSuffix | null {
    if (remaining.reduce((sum, count) => sum + count, 0) !== orderedPlayers.length - index) {
      return null;
    }
    if (index === orderedPlayers.length) {
      return remaining.every((count) => count === 0)
        ? { preferredCount: 0, filledPlayerElo: 0, roleIndexes: [] }
        : null;
    }

    const key = `${index}:${remaining.join(',')}`;
    if (memo.has(key)) return memo.get(key) ?? null;

    const player = orderedPlayers[index];
    let best: PlanSuffix | null = null;
    for (let roleIndex = 0; roleIndex < MATCH_POSITIONS.length; roleIndex += 1) {
      if (remaining[roleIndex] === 0) continue;
      const position = MATCH_POSITIONS[roleIndex];
      const nextCounts = [...remaining];
      nextCounts[roleIndex] -= 1;
      const suffix = bestPlan(index + 1, nextCounts);
      if (!suffix) continue;

      const preferred = player.positions.includes(position);
      const candidate: PlanSuffix = {
        preferredCount: suffix.preferredCount + Number(preferred),
        filledPlayerElo: suffix.filledPlayerElo + (preferred ? 0 : player.elo),
        roleIndexes: [roleIndex, ...suffix.roleIndexes],
      };
      if (
        !best ||
        candidate.preferredCount > best.preferredCount ||
        (candidate.preferredCount === best.preferredCount &&
          candidate.filledPlayerElo > best.filledPlayerElo) ||
        (candidate.preferredCount === best.preferredCount &&
          candidate.filledPlayerElo === best.filledPlayerElo &&
          compareRoleIndexes(candidate.roleIndexes, best.roleIndexes) < 0)
      ) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  const plan = bestPlan(0, initialCounts);
  if (!plan) throw new Error('The assigned team size does not match its required formation.');

  const assignments = orderedPlayers.map((player, index) => {
    const assignedPosition = MATCH_POSITIONS[plan.roleIndexes[index]];
    const preferred = player.positions.includes(assignedPosition);
    return {
      playerId: player.id,
      assignedPosition,
      assignmentStatus: preferred ? 'preferred' as const : 'filled' as const,
    };
  });

  return {
    assignments,
    preferredCount: plan.preferredCount,
    filledPlayerElo: plan.filledPlayerElo,
  };
}

function compareIdLists(a: readonly number[], b: readonly number[]) {
  const sortedA = [...a].sort((left, right) => left - right);
  const sortedB = [...b].sort((left, right) => left - right);
  for (let index = 0; index < Math.min(sortedA.length, sortedB.length); index += 1) {
    if (sortedA[index] !== sortedB[index]) return sortedA[index] - sortedB[index];
  }
  return sortedA.length - sortedB.length;
}

function underdogStatus(
  playerById: ReadonlyMap<number, MatchBalancePlayer>,
  roleById: ReadonlyMap<number, MatchPosition>,
  teamAIds: readonly number[],
  teamBIds: readonly number[],
  playerCount: number,
) {
  if (playerCount !== 13) return { satisfied: null, violation: 0, gap: 0 };

  const largerTeamIds = teamAIds.length === 7 ? teamAIds : teamBIds;
  const smallerTeamIds = teamAIds.length === 6 ? teamAIds : teamBIds;
  const liberoId = largerTeamIds.find((id) => roleById.get(id) === 'Libero');
  if (liberoId === undefined) {
    return { satisfied: false, violation: 1, gap: Number.MAX_SAFE_INTEGER };
  }

  const largerCoreElo = largerTeamIds
    .filter((id) => id !== liberoId)
    .reduce((sum, id) => sum + (playerById.get(id)?.elo ?? 0), 0);
  const smallerElo = smallerTeamIds
    .reduce((sum, id) => sum + (playerById.get(id)?.elo ?? 0), 0);
  const gap = Math.max(0, largerCoreElo - smallerElo);
  const satisfied = largerCoreElo <= smallerElo;
  return { satisfied, violation: satisfied ? 0 : 1, gap };
}

function makePositionShortages(
  teamAAssignments: readonly MatchPositionAssignment[],
  teamBAssignments: readonly MatchPositionAssignment[],
): PositionShortage[] {
  const counts = new Map<MatchPosition, number>();
  for (const assignment of [...teamAAssignments, ...teamBAssignments]) {
    if (assignment.assignmentStatus === 'filled') {
      counts.set(assignment.assignedPosition, (counts.get(assignment.assignedPosition) ?? 0) + 1);
    }
  }
  return MATCH_POSITIONS
    .map((position) => ({ position, filledCount: counts.get(position) ?? 0 }))
    .filter((shortage) => shortage.filledCount > 0);
}

function makeRoleAssignments(
  teamAPlayers: readonly MatchBalancePlayer[],
  teamBPlayers: readonly MatchBalancePlayer[],
  playerCount: number,
): MatchRoleAssignments & { filledPlayerElo: number } {
  const teamAPlan = assignTeamRoles(
    teamAPlayers,
    teamAPlayers.length === 7 ? SEVEN_PLAYER_COUNTS : SIX_PLAYER_COUNTS,
  );
  const teamBPlan = assignTeamRoles(
    teamBPlayers,
    teamBPlayers.length === 7 ? SEVEN_PLAYER_COUNTS : SIX_PLAYER_COUNTS,
  );
  const roleById = new Map(
    [...teamAPlan.assignments, ...teamBPlan.assignments]
      .map((assignment) => [assignment.playerId, assignment.assignedPosition]),
  );
  const playerById = new Map(
    [...teamAPlayers, ...teamBPlayers].map((player) => [player.id, player]),
  );
  const underdog = underdogStatus(
    playerById,
    roleById,
    teamAPlayers.map((player) => player.id),
    teamBPlayers.map((player) => player.id),
    playerCount,
  );
  return {
    teamAAssignments: teamAPlan.assignments,
    teamBAssignments: teamBPlan.assignments,
    positionShortages: makePositionShortages(teamAPlan.assignments, teamBPlan.assignments),
    preferredCount: teamAPlan.preferredCount + teamBPlan.preferredCount,
    underdogCoreGetsLibero: underdog.satisfied,
    totalEloGap: Math.abs(totalElo(teamAPlayers) - totalElo(teamBPlayers)),
    filledPlayerElo: teamAPlan.filledPlayerElo + teamBPlan.filledPlayerElo,
  };
}

/**
 * Assign exact role slots to an already selected pair of teams.
 * Manual assignments keep their team membership; role preferences and ELO are
 * used only to decide who fills each required slot.
 */
export function assignMatchRoles(
  players: readonly MatchBalancePlayer[],
  teamAIds: readonly number[],
  teamBIds: readonly number[],
): MatchRoleAssignments {
  if (![12, 13, 14].includes(players.length)) {
    throw new Error('A match role plan requires 12, 13, or 14 players.');
  }
  const allTeamIds = [...teamAIds, ...teamBIds];
  if (
    new Set(players.map((player) => player.id)).size !== players.length ||
    allTeamIds.length !== players.length ||
    new Set(allTeamIds).size !== players.length ||
    allTeamIds.some((id) => !players.some((player) => player.id === id))
  ) {
    throw new Error('Every selected player must appear on exactly one team.');
  }
  const expectedSizes = players.length === 12
    ? [[6, 6]]
    : players.length === 13
      ? [[6, 7], [7, 6]]
      : [[7, 7]];
  if (!expectedSizes.some(([a, b]) => teamAIds.length === a && teamBIds.length === b)) {
    throw new Error('The team sizes do not match the selected pool.');
  }

  const playerById = new Map(players.map((player) => [player.id, player]));
  const teamAPlayers = teamAIds.map((id) => playerById.get(id)!);
  const teamBPlayers = teamBIds.map((id) => playerById.get(id)!);
  const { filledPlayerElo: _filledPlayerElo, ...result } = makeRoleAssignments(
    teamAPlayers,
    teamBPlayers,
    players.length,
  );
  return result;
}

function compareSeedCandidates(a: BalanceCandidate, b: BalanceCandidate) {
  return (
    b.preferredCount - a.preferredCount ||
    b.filledPlayerElo - a.filledPlayerElo ||
    a.underdogRuleViolation - b.underdogRuleViolation ||
    a.underdogCoreGap - b.underdogCoreGap ||
    compareIdLists(a.teamAIds, b.teamAIds)
  );
}

function compareBalancedCandidates(a: BalanceCandidate, b: BalanceCandidate) {
  return (
    a.underdogRuleViolation - b.underdogRuleViolation ||
    a.underdogCoreGap - b.underdogCoreGap ||
    a.totalEloGap - b.totalEloGap ||
    compareIdLists(a.teamAIds, b.teamAIds)
  );
}

function sameRoleCanSwap(
  aId: number,
  bId: number,
  roleById: ReadonlyMap<number, MatchPosition>,
) {
  return roleById.get(aId) === roleById.get(bId);
}

function compareUnderdogToSeed(candidate: BalanceCandidate, seed: BalanceCandidate) {
  return candidate.underdogRuleViolation === seed.underdogRuleViolation &&
    candidate.underdogCoreGap <= seed.underdogCoreGap;
}

/**
 * Auto-balance flow:
 * 1. Enumerate valid team splits and assign every exact role slot. Maximize
 *    Preferred assignments first; use the highest-ELO remaining players for
 *    any Filled slots and report the shortage by role.
 * 2. Keep those role assignments fixed, then search every reachable exchange
 *    of players assigned the same role. Choose the smallest team-total ELO gap.
 * 3. For a 13-player pool, keep the assigned Libero with the lower-ELO
 *    six-player core whenever that is possible.
 */
export function balanceMatchTeams(
  players: readonly MatchBalancePlayer[],
): MatchBalanceResult {
  if (![12, 13, 14].includes(players.length)) {
    throw new Error('Auto-balance requires a pool of 12, 13, or 14 players.');
  }
  if (new Set(players.map((player) => player.id)).size !== players.length) {
    throw new Error('The selected player pool contains duplicate player IDs.');
  }
  if (players.some((player) => !Number.isFinite(player.elo) || player.elo < 0)) {
    throw new Error('Every selected player must have a valid non-negative ELO rating.');
  }

  const playerCount = players.length;
  const teamASizes = playerCount === 13 ? [6, 7] : [playerCount / 2];
  const playerById = new Map(players.map((player) => [player.id, player]));
  let seed: BalanceCandidate | null = null;

  // STEP 1 — Choose a position-complete starting formation before ELO swaps.
  for (const teamASize of teamASizes) {
    for (const teamA of combinations(players, teamASize)) {
      const teamAIds = teamA.map((player) => player.id);
      const teamAIdSet = new Set(teamAIds);
      const teamB = players.filter((player) => !teamAIdSet.has(player.id));
      const planned = makeRoleAssignments(teamA, teamB, playerCount);
      const assignments = [
        ...planned.teamAAssignments,
        ...planned.teamBAssignments,
      ];
      const roleById = new Map(
        assignments.map((assignment) => [assignment.playerId, assignment.assignedPosition]),
      );
      const underdog = underdogStatus(
        playerById,
        roleById,
        teamAIds,
        teamB.map((player) => player.id),
        playerCount,
      );
      const candidate: BalanceCandidate = {
        ...planned,
        teamAIds,
        teamBIds: teamB.map((player) => player.id),
        underdogRuleViolation: underdog.violation,
        underdogCoreGap: underdog.gap,
      };
      if (!seed || compareSeedCandidates(candidate, seed) < 0) seed = candidate;
    }
  }
  if (!seed) throw new Error('No team split could be generated for the selected pool.');

  // STEP 2 — Same-role exchanges only. Role labels and Preferred/Filled status
  // travel with each player while the two teams' exact formations stay intact.
  const roleById = new Map(
    [...seed.teamAAssignments, ...seed.teamBAssignments]
      .map((assignment) => [assignment.playerId, assignment.assignedPosition]),
  );
  let best = seed;
  const initialKey = [...seed.teamAIds].sort((a, b) => a - b).join(',');
  const queue: number[][] = [[...seed.teamAIds]];
  const enqueued = new Set<string>([initialKey]);
  const visited = new Set<string>();
  const allAssignments = [...seed.teamAAssignments, ...seed.teamBAssignments];

  while (queue.length) {
    const teamAIds = queue.shift()!;
    const key = [...teamAIds].sort((a, b) => a - b).join(',');
    enqueued.delete(key);
    if (visited.has(key)) continue;
    visited.add(key);

    const teamAIdSet = new Set(teamAIds);
    const teamBIds = players
      .filter((player) => !teamAIdSet.has(player.id))
      .map((player) => player.id);
    const candidateAssignmentsA = allAssignments.filter((assignment) =>
      teamAIdSet.has(assignment.playerId),
    );
    const candidateAssignmentsB = allAssignments.filter((assignment) =>
      !teamAIdSet.has(assignment.playerId),
    );
    const teamAPlayers = teamAIds.map((id) => playerById.get(id)!);
    const teamBPlayers = teamBIds.map((id) => playerById.get(id)!);
    const underdog = underdogStatus(
      playerById,
      roleById,
      teamAIds,
      teamBIds,
      playerCount,
    );
    const candidate: BalanceCandidate = {
      teamAIds: [...teamAIds],
      teamBIds,
      teamAAssignments: candidateAssignmentsA,
      teamBAssignments: candidateAssignmentsB,
      positionShortages: makePositionShortages(candidateAssignmentsA, candidateAssignmentsB),
      preferredCount: allAssignments.filter((assignment) =>
        assignment.assignmentStatus === 'preferred',
      ).length,
      underdogCoreGetsLibero: underdog.satisfied,
      underdogRuleViolation: underdog.violation,
      underdogCoreGap: underdog.gap,
      filledPlayerElo: allAssignments
        .filter((assignment) => assignment.assignmentStatus === 'filled')
        .reduce((sum, assignment) => sum + (playerById.get(assignment.playerId)?.elo ?? 0), 0),
      totalEloGap: Math.abs(totalElo(teamAPlayers) - totalElo(teamBPlayers)),
    };

    if (compareUnderdogToSeed(candidate, seed) && compareBalancedCandidates(candidate, best) < 0) {
      best = candidate;
    }

    for (const playerAId of teamAIds) {
      for (const playerBId of teamBIds) {
        if (!sameRoleCanSwap(playerAId, playerBId, roleById)) continue;
        const nextTeamAIds = teamAIds
          .filter((id) => id !== playerAId)
          .concat(playerBId);
        const nextKey = [...nextTeamAIds].sort((a, b) => a - b).join(',');
        if (!visited.has(nextKey) && !enqueued.has(nextKey)) {
          enqueued.add(nextKey);
          queue.push(nextTeamAIds);
        }
      }
    }
  }

  return {
    teamAIds: best.teamAIds,
    teamBIds: best.teamBIds,
    teamAAssignments: best.teamAAssignments,
    teamBAssignments: best.teamBAssignments,
    positionShortages: best.positionShortages,
    preferredCount: best.preferredCount,
    underdogCoreGetsLibero: best.underdogCoreGetsLibero,
    totalEloGap: best.totalEloGap,
  };
}

function* combinations<T>(
  values: readonly T[],
  count: number,
  start = 0,
  chosen: T[] = [],
): Generator<T[]> {
  if (count === 0) {
    yield [...chosen];
    return;
  }

  for (let index = start; index <= values.length - count; index += 1) {
    chosen.push(values[index]);
    yield* combinations(values, count - 1, index + 1, chosen);
    chosen.pop();
  }
}
