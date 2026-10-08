/**
 * Synthetic simulation. Imports only the actual pure TypeScript balancer.
 * No HTTP clients, app entry points, SQLite access, authentication or player data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { balanceMatchTeams, balanceAssignedTeams, assignMatchRoles } from '../../artifacts/volleyball-manager/src/match-balancing.ts';
import { configurations, expectedWin, updatesFor, mean, quantile, sd, spearman, pairAccuracy, randomGenerator } from './model.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const engine = args.engine ?? 'actual';
const size = Number(args.size ?? 12);
const populationSize = Number(args.population ?? 40);
const seedCount = Number(args.seeds ?? 5);
const target = Number(args.target ?? 100);
const outcomeScale = Number(args.scale ?? 400);
const repeated = args.repeated === 'true';
const outcomeModel = args.model ?? 'equal';
const output = args.output ?? `audits/elo-launch/results/${engine}-${size}-${outcomeScale}.json`;
const checkpointTargets = [10, 30, 50, 100].filter((x) => x <= target);
const positions = ['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite', 'Libero'];
const formation = ['Setter', 'Outside Hitter', 'Outside Hitter', 'Middle Blocker', 'Middle Blocker', 'Opposite', 'Libero'];

function makePlayers(seed) {
  const rng = randomGenerator(seed * 137 + 3);
  const players = Array.from({ length: populationSize }, (_, i) => {
    const primary = formation[i % 7];
    const remaining = positions.filter((r) => r !== primary);
    const secondary = remaining[Math.floor(rng() * remaining.length)];
    return {
      id: i + 1, group: i % 5, skill: 800 + (i % 5 - 2) * 180 + (rng() - 0.5) * 80,
      positions: [primary, secondary], elo: 800, matchesPlayed: 0, wins: 0,
      preferencesConfirmed: true, preferredRolePriority: false, prioritySince: null,
      lowAttendance: i % 5 === Math.floor(i / 5) % 5, joinedSession: i >= Math.floor(populationSize * 0.8) ? 20 : 0,
    };
  });
  // Centre the latent model at 800; it generates outcomes, not real ratings.
  const shift = mean(players.map((p) => p.skill)) - 800;
  for (const p of players) p.skill -= shift;
  return players;
}

function attendeeIds(players, seed, session) {
  const rng = randomGenerator(seed * 7919 + session * 31);
  const available = players.filter((p) => p.joinedSession <= session);
  const keys = available.map((p) => ({ p, key: -Math.log(Math.max(rng(), 1e-12)) / (p.lowAttendance ? 0.3 : 1) }));
  keys.sort((a, b) => a.key - b.key);
  const picked = keys.slice(0, size).map((x) => x.p);
  if (!picked.some((p) => p.positions.includes('Setter'))) {
    const setter = keys.find(({ p }) => p.positions.includes('Setter')).p;
    picked[picked.length - 1] = setter;
  }
  return picked.map((p) => p.id);
}

function proxyBalance(roster, seed) {
  // Explicit proxy: a random split with the REAL role assigner and fixed-role
  // ELO optimizer. Does not enumerate all preferred-role seed splits like Auto.
  const rng = randomGenerator(seed);
  const shuffled = roster.map((p) => ({ p, key: rng() })).sort((a, b) => a.key - b.key).map((x) => x.p);
  const a = shuffled.slice(0, Math.floor(size / 2)).map((p) => p.id);
  const b = shuffled.slice(Math.floor(size / 2)).map((p) => p.id);
  const roles = assignMatchRoles(roster, a, b);
  if (engine === 'random') return { ...roles, teamAIds: a, teamBIds: b };
  return balanceAssignedTeams(roster, { ...roles, teamAIds: a, teamBIds: b }, []);
}

function trueStrength(team, assignmentMap) {
  if (outcomeModel === 'equal') return mean(team.map((p) => p.skill));
  // Sensitivity only: setter influence 1.5, libero 0.7, everyone else 1.
  const weight = (p) => assignmentMap.get(p.id) === 'Setter' ? 1.5 : assignmentMap.get(p.id) === 'Libero' ? 0.7 : 1;
  return team.reduce((sum, p) => sum + weight(p) * p.skill, 0) / team.reduce((sum, p) => sum + weight(p), 0);
}

function snapshot(players, session, matches, checkpoints) {
  const joined = players.filter((p) => p.joinedSession <= session);
  const active = joined.filter((p) => !p.lowAttendance && p.joinedSession === 0);
  const eligible = joined.filter((p) => p.matchesPlayed >= 10);
  const r = joined.map((p) => p.elo);
  return {
    session: session + 1, totalMatches: matches, population: joined.length,
    regularMedianMatches: quantile(active.map((p) => p.matchesPlayed), 0.5),
    allMedianMatches: quantile(joined.map((p) => p.matchesPlayed), 0.5),
    lowMedianMatches: quantile(joined.filter((p) => p.lowAttendance).map((p) => p.matchesPlayed), 0.5),
    minMatches: Math.min(...joined.map((p) => p.matchesPlayed)),
    eligible: eligible.length, min: Math.min(...r), median: quantile(r, 0.5), max: Math.max(...r),
    mean: mean(r), sd: sd(r), rho: spearman(eligible), pairAccuracy: pairAccuracy(eligible),
    groupRatings: [0, 1, 2, 3, 4].map((g) => mean(eligible.filter((p) => p.group === g).map((p) => p.elo))),
    players: joined.map((p) => ({
      id: p.id, skill: p.skill, group: p.group, elo: p.elo, matchesPlayed: p.matchesPlayed,
      lowAttendance: p.lowAttendance, newcomer: p.joinedSession > 0,
      winRate: p.matchesPlayed ? p.wins / p.matchesPlayed : null,
    })),
    individualCheckpoints: checkpoints,
  };
}

function simulate(configuration, seed) {
  const players = makePlayers(seed);
  const byId = new Map(players.map((p) => [p.id, p]));
  const snapshots = {}, individualCheckpoints = [];
  const stableDeltas = [], veteranDeltas = [], sessionDeltas = [], winProbabilities = [], brier = [];
  const teamRatingGaps = [], teamSkillGaps = [];
  const teammatePairs = new Map(), opponentPairs = new Map();
  let mixedKDrift = 0, roundingDrift = 0, floorDrift = 0, totalMatches = 0, balancedMs = 0;
  let reusedSetup = null, lastSession = 0;
  for (let session = 0; session < 240; session += 1) {
    lastSession = session;
    const ids = repeated && session % 4 && reusedSetup ? reusedSetup.ids : attendeeIds(players, seed, session);
    const roster = ids.map((id) => byId.get(id));
    const startRatings = new Map(roster.map((p) => [p.id, [p.elo, p.matchesPlayed]]));
    const games = 3 + Number(randomGenerator(seed * 65537 + session)() > 0.5);
    for (let game = 0; game < games; game += 1) {
      const start = performance.now();
      let teams;
      if (repeated && reusedSetup && session % 4) {
        teams = reusedSetup.teams;
      } else {
        teams = engine === 'actual' ? balanceMatchTeams(roster) : proxyBalance(roster, seed * 65537 + session * 7 + game);
        reusedSetup = { ids, teams };
      }
      balancedMs += performance.now() - start;
      const a = teams.teamAIds.map((id) => byId.get(id));
      const b = teams.teamBIds.map((id) => byId.get(id));
      const assignments = [...teams.teamAAssignments, ...teams.teamBAssignments];
      const assignmentMap = new Map(assignments.map((x) => [x.playerId, x.assignedPosition]));
      const probability = expectedWin(trueStrength(a, assignmentMap), trueStrength(b, assignmentMap), outcomeScale);
      const predicted = expectedWin(mean(a.map((p) => p.elo)), mean(b.map((p) => p.elo)));
      const rng = randomGenerator(seed * 104729 + session * 11 + game);
      const winnerA = rng() < probability;
      winProbabilities.push(probability);
      brier.push((Number(winnerA) - predicted) ** 2);
      teamRatingGaps.push(Math.abs(mean(a.map((p) => p.elo)) - mean(b.map((p) => p.elo))));
      teamSkillGaps.push(Math.abs(trueStrength(a, assignmentMap) - trueStrength(b, assignmentMap)));
      const updates = updatesFor(a, b, winnerA, configuration);
      for (const update of updates) {
        const p = byId.get(update.playerId);
        if (p.matchesPlayed >= 10) stableDeltas.push(Math.abs(update.changeAmount));
        if (p.matchesPlayed >= 60) veteranDeltas.push(Math.abs(update.changeAmount));
        p.elo = update.eloAfter;
        p.matchesPlayed = update.matchesPlayedAfter;
        p.wins += Number(teams.teamAIds.includes(p.id) === winnerA);
        mixedKDrift += update.unroundedChange;
        roundingDrift += update.roundingChange;
        floorDrift += update.floorChange;
        if (checkpointTargets.includes(p.matchesPlayed)) {
          individualCheckpoints.push({ id: p.id, count: p.matchesPlayed, elo: p.elo, skill: p.skill, group: p.group, session: session + 1 });
        }
      }
      for (const assignment of assignments) {
        const p = byId.get(assignment.playerId);
        if (assignment.assignmentStatus === 'preferred') {
          p.preferredRolePriority = false;
          p.prioritySince = null;
        } else if (!p.preferredRolePriority) {
          p.preferredRolePriority = true;
          p.prioritySince = String(totalMatches).padStart(8, '0');
        }
      }
      for (const team of [a, b]) for (let i = 0; i < team.length; i += 1) for (let j = i + 1; j < team.length; j += 1) {
        const key = [team[i].id, team[j].id].sort((x, y) => x - y).join('-');
        teammatePairs.set(key, (teammatePairs.get(key) ?? 0) + 1);
      }
      for (const p of a) for (const q of b) {
        const key = [p.id, q.id].sort((x, y) => x - y).join('-');
        opponentPairs.set(key, (opponentPairs.get(key) ?? 0) + 1);
      }
      totalMatches += 1;
    }
    for (const p of roster) if (startRatings.get(p.id)[1] >= 30) sessionDeltas.push(Math.abs(p.elo - startRatings.get(p.id)[0]));
    const active = players.filter((p) => !p.lowAttendance && p.joinedSession === 0);
    const medianMatches = quantile(active.map((p) => p.matchesPlayed), 0.5);
    for (const checkpoint of checkpointTargets) if (!snapshots[checkpoint] && medianMatches >= checkpoint) {
      snapshots[checkpoint] = snapshot(players, session, totalMatches, [...individualCheckpoints]);
    }
    if (medianMatches >= target) break;
  }
  const final = snapshot(players, lastSession, totalMatches, individualCheckpoints);
  if (!snapshots[target]) throw new Error('Requested appearance target was not reached within 240 sessions');
  const metrics = {
    stableMeanAbsChange: mean(stableDeltas), veteranMeanAbsChange: mean(veteranDeltas),
    sessionMeanAbsChange: mean(sessionDeltas), sessionP90AbsChange: quantile(sessionDeltas, 0.9),
    mixedKDrift, roundingDrift, floorDrift, totalDrift: players.reduce((sum, p) => sum + p.elo - 800, 0),
    brier: mean(brier), teamRatingGap: mean(teamRatingGaps), teamSkillGap: mean(teamSkillGaps),
    averageTrueWinProbabilityDistance: mean(winProbabilities.map((p) => Math.abs(p - 0.5))),
    meanTeammateRepeats: mean([...teammatePairs.values()]), maxTeammateRepeats: Math.max(...teammatePairs.values()),
    meanOpponentRepeats: mean([...opponentPairs.values()]), balancedSeconds: balancedMs / 1000,
  };
  if (Math.abs(metrics.totalDrift - mixedKDrift - roundingDrift - floorDrift) > 1e-6) throw new Error('Drift accounting mismatch');
  if (players.some((p) => p.elo < 0)) throw new Error('Negative rating');
  return { configuration, seed, snapshots, metrics, finalPlayers: final.players, individualCheckpoints };
}

const results = [];
const started = performance.now();
for (let seed = 1; seed <= seedCount; seed += 1) for (const configuration of Object.keys(configurations)) {
  const before = performance.now();
  const run = simulate(configuration, seed);
  results.push(run);
  console.log(JSON.stringify({ engine, size, seed, configuration, seconds: ((performance.now() - before) / 1000).toFixed(1), checkpoints: Object.keys(run.snapshots), rho: run.snapshots[target]?.rho }));
  mkdirSync(output.slice(0, output.lastIndexOf('/')), { recursive: true });
  writeFileSync(output, JSON.stringify({
    metadata: { engine, size, populationSize, seedCount, target, outcomeScale, outcomeModel, repeated,
      checkpoints: checkpointTargets, seedDesign: 'identical population, attendance keys and outcome uniforms per seed across configurations', seconds: (performance.now() - started) / 1000 },
    results,
  }, null, 2));
}
