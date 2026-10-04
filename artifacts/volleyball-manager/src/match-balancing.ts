export interface MatchBalancePlayer {
  id: number;
  positions: readonly string[];
  elo: number;
}

export interface MatchBalanceResult {
  teamAIds: number[];
  teamBIds: number[];
  positionCoverage: number;
  formationComplete: boolean;
  setterOverload: number;
  liberoRuleSatisfied: boolean;
  underdogCoreGetsLibero: boolean | null;
  totalEloGap: number;
}

type Candidate = MatchBalanceResult & {
  roleDeficit: number;
  liberoViolations: number;
  underdogRuleViolation: number;
  underdogCoreGap: number;
  designatedLiberoAId: number | null;
  designatedLiberoBId: number | null;
};

const ROLE_SLOTS = [
  'Setter',
  'Outside Hitter',
  'Outside Hitter',
  'Middle Blocker',
  'Middle Blocker',
  'Opposite',
] as const;

const PRIMARY_POSITIONS = [
  'Setter',
  'Outside Hitter',
  'Middle Blocker',
  'Opposite',
  'Libero',
  'Other',
] as const;

function hasPosition(player: MatchBalancePlayer, position: string) {
  return player.positions.includes(position);
}

function primaryPosition(player: MatchBalancePlayer) {
  return PRIMARY_POSITIONS.find((position) =>
    position !== 'Other' && hasPosition(player, position),
  ) ?? 'Other';
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

function* samePositionSplits(
  players: readonly MatchBalancePlayer[],
  teamASize: number,
): Generator<MatchBalancePlayer[]> {
  const groups = PRIMARY_POSITIONS.map((position) => ({
    position,
    players: players.filter((player) => primaryPosition(player) === position),
  })).filter((group) => group.players.length > 0);

  function* chooseFromGroups(
    groupIndex: number,
    remaining: number,
    selected: MatchBalancePlayer[],
  ): Generator<MatchBalancePlayer[]> {
    if (groupIndex === groups.length) {
      if (remaining === 0) yield [...selected];
      return;
    }

    const group = groups[groupIndex];
    const remainingGroups = groups
      .slice(groupIndex + 1)
      .reduce((sum, next) => sum + next.players.length, 0);
    const minFromGroup = Math.max(0, remaining - remainingGroups);
    const maxFromGroup = Math.min(group.players.length, remaining);

    for (let count = minFromGroup; count <= maxFromGroup; count += 1) {
      for (const choice of combinations(group.players, count)) {
        yield* chooseFromGroups(
          groupIndex + 1,
          remaining - count,
          [...selected, ...choice],
        );
      }
    }
  }

  yield* chooseFromGroups(0, teamASize, []);
}

function maxRoleCoverage(
  players: readonly MatchBalancePlayer[],
  cache: Map<string, number>,
) {
  const cacheKey = players.map((player) => player.id).sort((a, b) => a - b).join(',');
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Assign each player to at most one required court role.
  let reachableMasks = new Set<number>([0]);
  for (const player of players) {
    const nextMasks = new Set(reachableMasks);
    for (const mask of reachableMasks) {
      ROLE_SLOTS.forEach((role, slot) => {
        if (hasPosition(player, role)) nextMasks.add(mask | (1 << slot));
      });
    }
    reachableMasks = nextMasks;
  }

  const coverage = Math.max(
    ...Array.from(reachableMasks, (mask) => {
      let count = 0;
      for (let remaining = mask; remaining; remaining &= remaining - 1) count += 1;
      return count;
    }),
  );
  cache.set(cacheKey, coverage);
  return coverage;
}

function teamTotal(players: readonly MatchBalancePlayer[]) {
  return players.reduce((total, player) => total + player.elo, 0);
}

function compareSeedCandidates(a: Candidate, b: Candidate) {
  return (
    a.roleDeficit - b.roleDeficit ||
    a.setterOverload - b.setterOverload ||
    a.liberoViolations - b.liberoViolations ||
    a.underdogRuleViolation - b.underdogRuleViolation ||
    a.underdogCoreGap - b.underdogCoreGap ||
    a.teamAIds.join(',').localeCompare(b.teamAIds.join(',')) ||
    (a.designatedLiberoAId ?? 0) - (b.designatedLiberoAId ?? 0) ||
    (a.designatedLiberoBId ?? 0) - (b.designatedLiberoBId ?? 0)
  );
}

function compareBalancedCandidates(a: Candidate, b: Candidate) {
  return (
    a.roleDeficit - b.roleDeficit ||
    a.setterOverload - b.setterOverload ||
    a.liberoViolations - b.liberoViolations ||
    a.underdogRuleViolation - b.underdogRuleViolation ||
    a.underdogCoreGap - b.underdogCoreGap ||
    a.totalEloGap - b.totalEloGap ||
    a.teamAIds.join(',').localeCompare(b.teamAIds.join(','))
  );
}

function liberoChoices(players: readonly MatchBalancePlayer[], required: boolean) {
  if (!required) return [null];
  const eligible = players.filter((player) => hasPosition(player, 'Libero'));
  return eligible.length ? eligible.map((player) => player.id) : [null];
}

function candidateForSplit(
  teamA: readonly MatchBalancePlayer[],
  teamB: readonly MatchBalancePlayer[],
  playerCount: number,
  roleCoverageCache: Map<string, number>,
) {
  const teamALiberoRequired = playerCount > 12 && teamA.length === 7;
  const teamBLiberoRequired = playerCount > 12 && teamB.length === 7;
  const teamAElo = teamTotal(teamA);
  const teamBElo = teamTotal(teamB);
  const candidates: Candidate[] = [];

  for (const designatedLiberoAId of liberoChoices(teamA, teamALiberoRequired)) {
    for (const designatedLiberoBId of liberoChoices(teamB, teamBLiberoRequired)) {
      const teamARolePlayers = designatedLiberoAId === null
        ? teamA
        : teamA.filter((player) => player.id !== designatedLiberoAId);
      const teamBRolePlayers = designatedLiberoBId === null
        ? teamB
        : teamB.filter((player) => player.id !== designatedLiberoBId);
      const roleDeficit =
        (ROLE_SLOTS.length - maxRoleCoverage(teamARolePlayers, roleCoverageCache)) +
        (ROLE_SLOTS.length - maxRoleCoverage(teamBRolePlayers, roleCoverageCache));
      const setterOverload =
        Math.max(0, teamA.filter((player) => hasPosition(player, 'Setter')).length - 1) +
        Math.max(0, teamB.filter((player) => hasPosition(player, 'Setter')).length - 1);

      let liberoViolations = 0;
      if (playerCount === 13) {
        if (teamALiberoRequired && designatedLiberoAId === null) liberoViolations += 1;
        if (teamBLiberoRequired && designatedLiberoBId === null) liberoViolations += 1;
        const smallTeam = teamA.length === 6 ? teamA : teamB;
        liberoViolations += smallTeam.filter((player) => hasPosition(player, 'Libero')).length;
      } else if (playerCount === 14) {
        if (designatedLiberoAId === null) liberoViolations += 1;
        if (designatedLiberoBId === null) liberoViolations += 1;
      }

      let underdogCoreGetsLibero: boolean | null = null;
      let underdogRuleViolation = 0;
      let underdogCoreGap = 0;
      if (playerCount === 13) {
        const largerTeam = teamA.length === 7 ? teamA : teamB;
        const smallerTeam = teamA.length === 6 ? teamA : teamB;
        const designatedLiberoId = teamA.length === 7
          ? designatedLiberoAId
          : designatedLiberoBId;
        if (designatedLiberoId !== null) {
          const libero = largerTeam.find((player) => player.id === designatedLiberoId);
          const coreElo = teamTotal(largerTeam) - (libero?.elo ?? 0);
          const smallerElo = teamTotal(smallerTeam);
          underdogCoreGetsLibero = coreElo <= smallerElo;
          underdogRuleViolation = underdogCoreGetsLibero ? 0 : 1;
          underdogCoreGap = Math.max(0, coreElo - smallerElo);
        } else {
          underdogRuleViolation = 1;
          underdogCoreGap = Number.MAX_SAFE_INTEGER;
        }
      }

      candidates.push({
        teamAIds: teamA.map((player) => player.id),
        teamBIds: teamB.map((player) => player.id),
        positionCoverage: ROLE_SLOTS.length * 2 - roleDeficit,
        formationComplete: roleDeficit === 0,
        setterOverload,
        liberoRuleSatisfied: liberoViolations === 0,
        underdogCoreGetsLibero,
        totalEloGap: Math.abs(teamAElo - teamBElo),
        roleDeficit,
        liberoViolations,
        underdogRuleViolation,
        underdogCoreGap,
        designatedLiberoAId,
        designatedLiberoBId,
      });
    }
  }

  return candidates.sort(compareSeedCandidates)[0];
}

function samePositionSwapAllowed(a: MatchBalancePlayer, b: MatchBalancePlayer) {
  return a.positions.some((position) => b.positions.includes(position));
}

function preservesPositionPriority(candidate: Candidate, seed: Candidate) {
  return candidate.roleDeficit === seed.roleDeficit &&
    candidate.setterOverload === seed.setterOverload &&
    candidate.liberoViolations === seed.liberoViolations &&
    candidate.underdogRuleViolation === seed.underdogRuleViolation &&
    candidate.underdogCoreGap <= seed.underdogCoreGap;
}

/**
 * Position-first auto-balancing:
 * 1. Search a deterministic starting split that maximizes distinct-player
 *    coverage of Setter / 2 Outside / 2 Middle / Opposite and avoids stacked
 *    setters whenever a better formation exists.
 * 2. Traverse same-position player swaps that preserve the best formation,
 *    setter split, and roster rules; choose the smallest possible total-ELO gap
 *    among the reachable splits.
 * 3. For 13 players, the lower-ELO six-player core receives the extra Libero.
 *    If that cannot coexist with the best available formation, flag the result.
 *
 * Only 12–14 players are searched, so the swap search is bounded to a few
 * thousand team splits rather than relying on a greedy local-swap guess.
 */
export function balanceMatchTeams(players: readonly MatchBalancePlayer[]): MatchBalanceResult {
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
  let seed: Candidate | null = null;
  const roleCoverageCache = new Map<string, number>();

  // STEP 1 — Positions first. Do not use ELO as a tiebreaker for the seed.
  for (const teamASize of teamASizes) {
    for (const teamA of samePositionSplits(players, teamASize)) {
      const teamAIds = new Set(teamA.map((player) => player.id));
      const teamB = players.filter((player) => !teamAIds.has(player.id));
      const candidate = candidateForSplit(teamA, teamB, playerCount, roleCoverageCache);
      if (candidate && (!seed || compareSeedCandidates(candidate, seed) < 0)) {
        seed = candidate;
      }
    }
  }
  if (!seed) throw new Error('No team split could be generated for the selected pool.');

  // STEP 2 — Same-position exchanges only; keep position quality and roster
  // constraints fixed while finding the globally smallest reachable ELO gap.
  let best = seed;
  const queue: number[][] = [seed.teamAIds];
  const firstKey = [...seed.teamAIds].sort((a, b) => a - b).join(',');
  const enqueued = new Set<string>([firstKey]);
  const visited = new Set<string>();
  while (queue.length) {
    const teamAIds = queue.shift()!;
    const key = [...teamAIds].sort((a, b) => a - b).join(',');
    enqueued.delete(key);
    if (visited.has(key)) continue;
    visited.add(key);

    const teamAIdSet = new Set(teamAIds);
    const teamA = players.filter((player) => teamAIdSet.has(player.id));
    const teamB = players.filter((player) => !teamAIdSet.has(player.id));
    const candidate = candidateForSplit(teamA, teamB, playerCount, roleCoverageCache);
    if (!candidate || !preservesPositionPriority(candidate, seed)) continue;
    if (compareBalancedCandidates(candidate, best) < 0) best = candidate;

    for (const playerA of teamA) {
      for (const playerB of teamB) {
        if (!samePositionSwapAllowed(playerA, playerB)) continue;
        const nextTeamAIds = teamAIds
          .filter((id) => id !== playerA.id)
          .concat(playerB.id);
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
    positionCoverage: best.positionCoverage,
    formationComplete: best.formationComplete,
    setterOverload: best.setterOverload,
    liberoRuleSatisfied: best.liberoRuleSatisfied,
    underdogCoreGetsLibero: best.underdogCoreGetsLibero,
    totalEloGap: best.totalEloGap,
  };
}