export interface MatchBalancePlayer {
  id: number;
  positions: readonly string[];
  elo: number;
  preferencesConfirmed?: boolean;
  preferredRolePriority?: boolean;
  prioritySince?: string | null;
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
  preferenceRank: number | null;
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
  rankCost: number;
  specialistCost: number;
  priorityScore: number;
}

export interface MatchBalanceResult extends MatchRoleAssignments {
  teamAIds: number[];
  teamBIds: number[];
}

interface TeamPlan {
  assignments: MatchPositionAssignment[];
  preferredCount: number;
  filledPlayerElo: number;
  rankCost: number;
  specialistCost: number;
  priorityScore: number;
}

interface PlanSuffix {
  preferredCount: number;
  filledPlayerElo: number;
  roleIndexes: number[];
  rankCost: number;
  specialistCost: number;
  priorityScore: number;
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
 * Preferred coverage precedes rank displacement, compensation ties and
 * specialist protection. Remaining slots use the highest-ELO available cover.
 * Final ties use stable player and role order, never input order or randomness.
 */
function assignTeamRoles(
  players: readonly MatchBalancePlayer[],
  requiredCounts: Record<MatchPosition, number>,
  priorityWeights: ReadonlyMap<number, number>,
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
        ? { preferredCount: 0, filledPlayerElo: 0, roleIndexes: [], rankCost: 0, specialistCost: 0, priorityScore: 0 }
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
      const rank = player.positions.indexOf(position);
      // Rank displacement first; compensation is precisely one rank for the
      // top choice, including rank 1 (cost -1). Specialist weighting only
      // resolves equal aggregate rank quality, never overrides coverage.
      const displacement = preferred ? rank - Number(Boolean(player.preferredRolePriority) && rank === 0) : 0;
      const viableCount = player.positions.filter((role) => requiredCounts[role as MatchPosition] > 0).length;
      const candidate: PlanSuffix = {
        preferredCount: suffix.preferredCount + Number(preferred),
        filledPlayerElo: suffix.filledPlayerElo + (preferred ? 0 : player.elo),
        roleIndexes: [roleIndex, ...suffix.roleIndexes],
        rankCost: suffix.rankCost + displacement,
        specialistCost: suffix.specialistCost + (preferred ? rank * (6 - viableCount) : 0),
        priorityScore: suffix.priorityScore + (preferred && rank === 0 ? priorityWeights.get(player.id) ?? 0 : 0),
      };
      if (
        !best ||
        candidate.preferredCount > best.preferredCount ||
        (candidate.preferredCount === best.preferredCount && (
          candidate.rankCost < best.rankCost ||
          (candidate.rankCost === best.rankCost && (
            candidate.priorityScore > best.priorityScore ||
            (candidate.priorityScore === best.priorityScore && (
              candidate.specialistCost < best.specialistCost ||
              (candidate.specialistCost === best.specialistCost && (
                candidate.filledPlayerElo > best.filledPlayerElo ||
                (candidate.filledPlayerElo === best.filledPlayerElo &&
                  compareRoleIndexes(candidate.roleIndexes, best.roleIndexes) < 0)
              ))
            ))
          ))
        ))
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
      preferenceRank: preferred ? player.positions.indexOf(assignedPosition) + 1 : null,
    };
  });

  return {
    assignments,
    preferredCount: plan.preferredCount,
    filledPlayerElo: plan.filledPlayerElo,
    rankCost: plan.rankCost,
    specialistCost: plan.specialistCost,
    priorityScore: plan.priorityScore,
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
  const pending = [...teamAPlayers, ...teamBPlayers].filter((player) => player.preferredRolePriority)
    .sort((a, b) => b.elo - a.elo || (a.prioritySince ?? '').localeCompare(b.prioritySince ?? '') || a.id - b.id);
  // Binary significance gives a deterministic ELO/wait/ID comparison for
  // equal-quality top-choice compensation, independent of team/input order.
  const priorityWeights = new Map(pending.map((player, index) => [player.id, 2 ** (pending.length - index - 1)]));
  const teamAPlan = assignTeamRoles(
    teamAPlayers,
    teamAPlayers.length === 7 ? SEVEN_PLAYER_COUNTS : SIX_PLAYER_COUNTS,
    priorityWeights,
  );
  const teamBPlan = assignTeamRoles(
    teamBPlayers,
    teamBPlayers.length === 7 ? SEVEN_PLAYER_COUNTS : SIX_PLAYER_COUNTS,
    priorityWeights,
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
    rankCost: teamAPlan.rankCost + teamBPlan.rankCost,
    specialistCost: teamAPlan.specialistCost + teamBPlan.specialistCost,
    priorityScore: teamAPlan.priorityScore + teamBPlan.priorityScore,
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
  validateRankedPool(players);
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
    a.rankCost - b.rankCost ||
    b.priorityScore - a.priorityScore ||
    a.specialistCost - b.specialistCost ||
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
  validateRankedPool(players);
  players = [...players].sort((a, b) => a.id - b.id);
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
  return balanceAssignedTeams(players, seed);
}

/** Improve ELO without reassigning any player's role, rank, or compensation. */
export function balanceAssignedTeams(
  players: readonly MatchBalancePlayer[],
  roster: MatchBalanceResult,
): MatchBalanceResult {
  validateRankedPool(players);
  players = [...players].sort((a, b) => a.id - b.id);
  // Validate membership and formation before accepting a fixed-role roster.
  assignMatchRoles(players, roster.teamAIds, roster.teamBIds);
  const allRosterAssignments = [...roster.teamAAssignments, ...roster.teamBAssignments];
  if (allRosterAssignments.length !== players.length || new Set(allRosterAssignments.map((a) => a.playerId)).size !== players.length) {
    throw new Error('Every selected player needs exactly one fixed role.');
  }
  for (const [ids, assignments] of [[roster.teamAIds, roster.teamAAssignments], [roster.teamBIds, roster.teamBAssignments]] as const) {
    const counts = ids.length === 7 ? SEVEN_PLAYER_COUNTS : SIX_PLAYER_COUNTS;
    if (assignments.some((a) => !ids.includes(a.playerId)) ||
      MATCH_POSITIONS.some((role) => assignments.filter((a) => a.assignedPosition === role).length !== counts[role])) {
      throw new Error('Fixed roles must retain the exact team formation.');
    }
    for (const assignment of assignments) {
      const player = players.find((p) => p.id === assignment.playerId)!;
      const rank = player.positions.indexOf(assignment.assignedPosition) + 1;
      if (assignment.assignmentStatus !== (rank ? 'preferred' : 'filled') || assignment.preferenceRank !== (rank || null)) {
        throw new Error('Fixed role classification must match the player preferences.');
      }
    }
  }
  const playerCount = players.length;
  const playerById = new Map(players.map((player) => [player.id, player]));
  const initialRoles = new Map(allRosterAssignments.map((a) => [a.playerId, a.assignedPosition]));
  const initialUnderdog = underdogStatus(playerById, initialRoles, roster.teamAIds, roster.teamBIds, playerCount);
  const seed: BalanceCandidate = {
    ...roster,
    totalEloGap: Math.abs(totalElo(players.filter((p) => roster.teamAIds.includes(p.id))) - totalElo(players.filter((p) => roster.teamBIds.includes(p.id)))),
    filledPlayerElo: allRosterAssignments.filter((a) => a.assignmentStatus === 'filled').reduce((sum, a) => sum + playerById.get(a.playerId)!.elo, 0),
    underdogRuleViolation: initialUnderdog.violation,
    underdogCoreGap: initialUnderdog.gap,
  };
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
      rankCost: seed.rankCost,
      specialistCost: seed.specialistCost,
      priorityScore: seed.priorityScore,
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
    rankCost: best.rankCost,
    specialistCost: best.specialistCost,
    priorityScore: best.priorityScore,
  };
}

function validateRankedPool(players: readonly MatchBalancePlayer[]) {
  for (const player of players) {
    if (!player.preferencesConfirmed || player.positions.length < 3 || player.positions.length > 5 ||
      new Set(player.positions).size !== player.positions.length ||
      player.positions.some((role) => !MATCH_POSITIONS.includes(role as MatchPosition))) {
      throw new Error('Every selected player must confirm 3–5 unique ranked preferences before a new match.');
    }
    if (!Number.isFinite(player.elo) || player.elo < 0) throw new Error('Every selected player needs a valid non-negative ELO.');
  }
  if (!players.some((player) => player.positions.includes('Setter'))) {
    throw new Error('Select at least one Setter-capable player. Other role shortages may be Filled.');
  }
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
