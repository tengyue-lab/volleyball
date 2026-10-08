"""Self-contained, analysis-only report built from completed synthetic results."""
from collections import Counter
from html import escape
import gzip
import json
from pathlib import Path
import statistics as st

ROOT = Path(__file__).resolve().parent
summary = json.loads((ROOT / "results/summary.json").read_text())
main = summary["actual-12-400"]
configs = main["configurations"]
club = json.loads((ROOT / "results/current-aggregate.json").read_text())
validation = json.loads((ROOT / "results/proxy-validation.json").read_text())
evidence = json.loads((ROOT / "results/verification.json").read_text())
names = {"current": "Current 60/40/32/20", "two64_24": "64/24", "two48_24": "48/24", "two64_32": "64/32"}
parts = []

def read_json(path):
    if path.exists():
        return json.loads(path.read_text())
    with gzip.open(str(path) + ".gz", "rt") as source:
        return json.load(source)


def number(value, digits=1):
    return "—" if value is None else f"{value:,.{digits}f}"


def section(title):
    parts.append(f"<h2>{escape(title)}</h2>")


def p(text):
    parts.append(f"<p>{escape(text)}</p>")


def table(headers, rows, caption=None):
    if caption:
        parts.append(f"<p class='caption'>{escape(caption)}</p>")
    parts.append("<div class='table-wrap'><table><thead><tr>" +
                 "".join(f"<th>{escape(str(x))}</th>" for x in headers) +
                 "</tr></thead><tbody>" +
                 "".join("<tr>" + "".join(f"<td>{escape(str(x))}</td>" for x in row) + "</tr>" for row in rows) +
                 "</tbody></table></div>")


def bullet(items):
    parts.append("<ul>" + "".join(f"<li>{escape(x)}</li>" for x in items) + "</ul>")


section("A. Recommendation and scope")
p("Keep the existing four-stage K progression: 60 for matches 1–10, 40 for 11–30, 32 for 31–60 and 20 from match 61. Keep starting ELO 800, ten placement games and the floor at zero. The evidence does not justify simplifying the K system just to reduce the number of stages.")
p("This is not a claim that four stages are universally more accurate. At 100 appearances, the 24-K candidates have effectively tied skill-order accuracy in the main experiment; paired uncertainty is wide. The four-stage system separates skill groups more strongly, learns faster in the early climbing phase, and has lower veteran per-match movement. Two-stage 24-K systems are a little quieter during matches 31–60. No two-stage candidate consistently improves both accuracy and stability across the tested assumptions.")
p("Separately, propose display thresholds with 800 inside Iron. This changes rank labels, not ratings, win probabilities, K, matchmaking, counters or result calculations. No application source, database records, algorithm, permission, schema or deployment has been changed. All proposed implementation remains subject to approval.")
table(["Decision", "Recommendation", "Status"], [
    ["Starting ELO", "800 (already implemented)", "Keep"],
    ["K progression", "60 → 40 → 32 → 20", "Keep"],
    ["Placement / public eligibility", "10 actual completed appearances", "Keep"],
    ["Rating floor", "0; never introduce an 800 floor", "Keep"],
    ["Starting tier", "Iron through display thresholds only", "Proposed for approval"],
    ["Historical / integrity concerns", "Review the specific findings below", "No fixes applied"],
])

section("B. Current implementation audit")
table(["Area", "Actual implementation"], [
    ["Baseline", "rating_progression.py: STARTING_ELO = 800; player creation defaults to it; admins may explicitly supply or edit a non-negative integer ELO."],
    ["Expected result", "Mean of current Team A ELO versus mean of current Team B ELO; expected_A = 1 / (1 + 10^((mean_B − mean_A)/400)). Extreme exponents are guarded."],
    ["Update", "Per player: max(0, floor(ELO_before + K × (actual − expected_team) + 0.5)). Winner=1, loser=0; no draws; score margin is not used."],
    ["K selection", "Uses each player's stored matches_played BEFORE this result. Boundaries are count 0–9:60, 10–29:40, 30–59:32, 60+:20."],
    ["Team members", "Each receives the same expected team probability, but not necessarily the same change: K is individual; flooring can differ."],
    ["Timing", "No ELO on upcoming-match creation. Completion loads current player ratings, not the old rating in the saved roster."],
    ["Counters / placement", "Persisted counter controls K; displayed matchesPlayed/provisional and leaderboard eligibility use deduplicated actual completed-roster appearances."],
    ["Rank", "Derived from ELO. Existing tier minima: Iron0, Bronze800, Silver1100, Gold1400, Platinum1700, Diamond2000, Masters2300; three divisions below Masters."],
    ["Exactly-once result", "BEGIN IMMEDIATE plus upcoming-status check; concurrent/repeated submission cannot apply the same active result twice."],
    ["Audit", "Records K used, rating/rank before and after, count before and after. Historical K is not recomputed on reversal."],
    ["Reversal", "Restores exact recorded before-ELO and stored counter, recomputes rank from ELO, deactivates priority events and replays priority; blocks reversing past a later active result affecting a participant."],
    ["Priority", "Completed preferred assignment clears priority; completed Filled assignment grants/retains earliest pending priority. It is independent of public visibility."],
    ["Public leaderboard", "Opt-in only; actual appearances ≥10; ordered by ELO descending, then name case-insensitively and ID; limited to 5 AFTER eligibility filtering."],
    ["Privacy", "Leaderboard DTO contains id, placement, name, mostPlayedPosition, tier only. Public match data excludes ELO/audits. Linked profile can see own exact ELO; administrators retain authorized audit/rating access."],
    ["Most-played position", "Actual completed assigned roles, not preferences. Deterministic position-order tie-break; incomplete/ambiguous reliable history yields a neutral placeholder."],
])
p("The existing displayed Provisional bug was addressed by the completed-appearance projection: the flag is count <10, so the tenth completed appearance removes it. That does not backfill the older persisted K counter. A fresh launch with empty players/history keeps both count sources aligned through normal completion and reversal.")
p(f"Read-only local workspace aggregate, not a production-database query: {club['players']} players; rating min/median/max {club['rating_min_median_max']}; {club['completed_matches']} completed matches. All {club['players_with_counter_disagreement']} players have a stored counter/history mismatch: stored range {club['stored_counter_range']}, actual appearance range {club['appearance_count_range']}. There are {club['audit_rows_without_match']} audit rows without a match and {club['completed_without_result_audits']} completed matches without any result audits. These legacy ratings are not used as simulation inputs or as a reason to manipulate thresholds; the user plans a fresh start.")

section("C. Isolated simulation method")
total_runs = sum(s["metadata"]["seedCount"] * 4 for s in summary.values())
total_games = sum(s["simulatedMatches"] for s in summary.values())
p(f"{total_runs:,} completed synthetic runs, {total_games:,} synthetic matches, four K configurations. The primary comparison uses five seeds and the real unchanged Auto Balance implementation with 12-player 6/6 rosters. Additional sensitivity runs use 30-, 40- and 50-player communities; 13- and 14-player rosters; different outcome noise; role influence; repeated lineups; and random-team controls.")
bullet([
    "Primary population: 40 synthetic players, five evenly represented skill groups. Latent strengths are centred at 800, group offsets −360/−180/0/+180/+360 with ±40 individual variation.",
    "Latent skill exists only to generate synthetic outcomes and evaluate ordering. It is not imported club ELO, a proposed new points system or a measured real-world skill scale.",
    "Each Saturday has one selected roster and 3–4 games. Attendance uses a weighted lottery: regular weight1, low-attendance weight0.3. Roughly 20% join after session20. At least one eligible setter is selected.",
    "Preferences are two ranked roles per synthetic player. The real role assigner is used, with completion-based preferred/Filled priority state mirrored between games. Skill is static; no injuries, skill improvement, intentional underperformance, captain effects or real match footage are modelled.",
    "Primary outcome probability is the logistic comparison of team-average latent strength on scale400. Sensitivities use scale200 (stronger outcome signal) or setter influence1.5/libero0.7. Those are assumptions, not validated volleyball physics.",
    "All configurations share each seed's population, attendance keys and game outcome uniforms. Their teams can differ because ratings affect balancing, so they need not have identical winners.",
    "Stop when original regular attendees have median100 appearances. Snapshot checkpoints are regular-median10/30/50/100, not every player's count. Exact individual appearance milestones are reported separately.",
    "Skill accuracy uses per-run Spearman correlation (higher is better) and correctly ordered pairs separated by at least100 latent points. Tied ratings receive half credit. Different-seed summaries—not millions of dependent appearances—are the uncertainty unit.",
    "Stability uses absolute per-match changes after count60 and absolute Saturday net changes for players entering that session with ≥30 appearances. These are different time windows; neither measures pure noise separately from legitimate skill correction.",
])
p("The full 14-player Auto Balance enumerates preferred-role seed splits and cost about0.7 seconds per sampled roster. Running all long 14-player sensitivities through it would be much more expensive. Therefore those runs are explicitly a proxy: random split → real role assigner → real fixed-role ELO optimizer. The proxy skips global preferred-role seed enumeration and is NOT claimed equivalent to the full balancer. The primary 12-player long comparison does use the full balancer.")
table(["Roster size", "Actual sampled cases", "Mean Auto time, ms", "Mean preferred, Auto / proxy", "Mean team-average ELO gap, Auto / proxy"],
      [[size, 8, number(st.mean(x["actualMs"] for x in validation if x["size"] == size), 0),
        f"{number(st.mean(x['actualPreferred'] for x in validation if x['size'] == size), 2)} / {number(st.mean(x['proxyPreferred'] for x in validation if x['size'] == size), 2)}",
        f"{number(st.mean(x['actualGap'] for x in validation if x['size'] == size), 2)} / {number(st.mean(x['proxyGap'] for x in validation if x['size'] == size), 2)}"]
       for size in [12, 13, 14]],
      "Short validation = 24 real-balancer cases, not a full 13/14-player long-run study. The large 13-player discrepancy is a limitation, not evidence the proxy validates that case.")
p("The audit arithmetic mirror was checked against 1,000 synthetic matches using the actual Python calculation safely extracted in memory. The ordinary Flask module creates a default database at import, so tests removed that global initialization and directed defaults to a temporary directory. No simulation invokes live routes or reads real players.")

section("D. Main K-factor comparison")
table(["Configuration", "Accuracy 30 (ρ)", "Accuracy 100 (ρ)", "Ordered pairs at100", "60+ mean |Δ|", "30+ Saturday mean |net Δ|", "30+ Saturday p90"],
      [[names[k], number(v["checkpoints"]["30"]["rho"], 3), number(v["checkpoints"]["100"]["rho"], 3),
        number(v["checkpoints"]["100"]["pairAccuracy"] * 100) + "%",
        number(v["metrics"]["veteranMeanAbsChange"]), number(v["metrics"]["sessionMeanAbsChange"]),
        number(v["metrics"]["sessionP90AbsChange"])] for k, v in configs.items()],
      "Means across five seeds. Saturday p90 is the mean of each run's p90, not a pooled percentile.")
p("Current versus64/24: nearly tied final ordering, stronger early climbing accuracy for current, smaller veteran steps, but about one additional rating point of average Saturday movement across the broader30+ window. Current versus48/24: nearly tied final ordering, better early placement/climbing signal for current; 48/24 has narrower spread but that is not proof of better accuracy. Current versus64/32: current has better mean final ordering and materially smaller veteran and Saturday movement in this experiment.")
table(["Current minus candidate at100", "Mean paired ρ difference", "Approximate95% t interval", "Seeds current higher"],
      [[names[k], f"{v['rho_current_minus_candidate']:+.3f}",
        f"[{v['approx_95_ci'][0]:+.3f}, {v['approx_95_ci'][1]:+.3f}]", f"{v['seeds_current_higher']} / 5"]
       for k, v in main["paired"].items()],
      "All intervals include zero. Five seeds do not prove universal accuracy superiority. Sensitivity outcomes below also vary.")
p("At an exactly even game, current veteran K20 produces approximately±10, versus±12 withK24 and±16 withK32. That deterministic late-stage stability advantage is real, even when noisy simulation accuracy differences are inconclusive. The four-stage climbing K40 and established K32 deliberately retain more adaptation than K24 before eventually dropping below it.")

section("E. Learning checkpoints and rating distributions")
table(["Regular-median appearances", "Configuration", "ρ", "Mean run minimum", "Mean run median", "Mean run maximum", "Rating SD"],
      [[n, names[k], number(v["checkpoints"][str(n)]["rho"], 3),
        number(v["checkpoints"][str(n)]["min"], 0), number(v["checkpoints"][str(n)]["median"], 0),
        number(v["checkpoints"][str(n)]["max"], 0), number(v["checkpoints"][str(n)]["sd"], 0)]
       for n in [10, 30, 50, 100] for k, v in configs.items()],
      "Snapshot extrema are averaged across runs, not guaranteed bounds. Low-attendance players and newcomers can have fewer appearances.")
raw_main = read_json(ROOT / "results/actual-12-400.json")
milestones = [p for r in raw_main["results"] if r["configuration"] == "current" for p in r["individualCheckpoints"]]
milestone_rows = []
for n in [10, 30, 50, 100]:
    values = [p["elo"] for p in milestones if p["count"] == n]
    milestone_rows.append([n, len(values), min(values), number(st.median(values), 0), max(values),
                           number(st.pstdev(values), 0),
                           number(sum(x >= 850 for x in values) / len(values) * 100) + "%"])
table(["Exact individual appearance", "Observations across5 seeds", "Minimum", "Median", "Maximum", "SD", "At/above proposed Bronze850"],
      milestone_rows, "Current K only. These observations occur on different Saturdays; later milestones are attendance-selected, not a contemporaneous 40-player leaderboard and not first-promotion times.")
table(["Rating band at regular-median100", *names.values()],
      [[f"{low}–{low + 99}", *[number(configs[k]["checkpoints"]["100"]["bins"][str(low)]) for k in names]]
       for low in range(300, 1400, 100)],
      "Mean number of joined players per run, all visibility hypothetical. Out-of-range bands above1399 were zero in these main snapshots.")
table(["Synthetic skill group (low→high)", *names.values()],
      [[i + 1, *[number(configs[k]["checkpoints"]["100"]["groupRatings"][i], 0) for k in names]] for i in range(5)],
      "Mean ratings per skill group; latent group gaps were180. Current's wider group separation is useful, but width alone is not accuracy.")
p("Players are not locked at800: all candidates produce ratings both above and below baseline, and group averages increasingly separate. The current system's mean strongest-minus-weakest group gap is larger than either24-K candidate; nevertheless their final ordering is similar. There is no800 floor to trap weaker players or add upward-only progression.")

section("F. Sensitivities: no consistently superior simplification")
scenario_names = {
    "actual-12-400": "Full Auto,12 players,5 seeds",
    "proxy-14-400": "Proxy14, normal outcomes,20 seeds",
    "proxy-14-200": "Proxy14, stronger signal,20 seeds",
    "proxy-14-roles": "Proxy14, role-weighted outcomes,20 seeds",
    "proxy-14-repeated": "Proxy14, teams reused across4 Saturdays,20 seeds",
    "proxy-13-400": "Proxy13,6/7 rosters,10 seeds",
    "proxy-30players": "Proxy14, community30,5 seeds",
    "proxy-50players": "Proxy14, community50,5 seeds",
    "random-14-400": "Random teams + real roles,14 players,20 seeds",
}
table(["Scenario", *names.values()],
      [[scenario_names[key], *[number(value["configurations"][k]["checkpoints"]["100"]["rho"], 3) for k in names]]
       for key, value in summary.items()],
      "Accuracy = mean seed Spearmanρ at the regular-median100 snapshot. Long13/14-player rows are proxies, not full Auto validation.")
p("The24-K candidates generally have less movement during the30+ window but more veteran per-match movement than current. K32 sometimes buys better ordering under a different outcome assumption at a clear volatility cost; it is not a consistent upgrade. The broad comparison supports retaining the existing compromise rather than claiming more stages inherently improve every metric.")
p("Repeated frozen lineups hurt ordering more than the choice between current and64/24. Changing teammates/opponents gives the system more independent evidence about individual strength. A larger K does not solve teammate confounding. In the random-team control, ordering was not better than the matched14-player fixed-role optimized proxy; this model does not support the claim that balancing necessarily prevents ratings from separating.")
p("Balanced reported team ELO can make predicted wins stay close to50%, while true synthetic strengths are still imbalanced. Main current mean reported team-average gap was " +
  number(configs["current"]["metrics"]["teamRatingGap"]) + " versus latent gap " +
  number(configs["current"]["metrics"]["teamSkillGap"]) + ". Win-prediction Brier scores were about0.25 across configurations: predictive differences were small, and this deliberately balanced schedule is a weak test of calibrated forecasting. Do not confuse excellent reported balance with known real skill balance.")

section("G. Attendance, late joiners and placement confidence")
table(["Current configuration subgroup", "Mean final appearances", "Mean rating", "Mean latent strength", "Anchored latent-target MAE"],
      [[label, number(configs["current"][key]["meanMatches"]), number(configs["current"][key]["meanElo"], 0),
        number(configs["current"][key]["meanLatentSkill"], 0), number(configs["current"][key]["anchoredMAE"], 0)]
       for key, label in [("regular", "Original regulars"), ("lowAttendance", "Low attendance"), ("newcomer", "Late joiners")]],
      "Low attendance and newcomer groups overlap. Their latent skill distributions differ. MAE assumes the synthetic scale400 model and800 anchor; it is not a validated absolute real skill error.")
p("No inactivity deduction or attendance bonus exists. Rare players simply have less evidence and stay on higher K longer. Their larger estimation error is expected; a ten-match eligibility gate does not make ratings certain. Higher provisional K improves adaptation but also increases luck sensitivity. Newcomer aggregate ratings cannot be interpreted as an unfair boost without accounting for skill mix, appearances and match results.")
p("At3–4 games per attended Saturday,10 appearances need about3 attended sessions,30 about8–10,50 about13–17, and100 about25–34. Calendar weeks depend on attendance. The40-person/single-roster experiment required about" +
  number(configs["current"]["checkpoints"]["100"]["session"], 0) +
  " Saturdays for regulars to reach median100; that is not a prediction for the current14-person club, whose regulars may attend nearly every week.")
p("Keep the intended ten-match provisional threshold, derived from actual completed appearances, and keep provisional players out of this established-only publicTop5. Do not advertise it as a confidence guarantee. Profile progress, automatic tenth-match transition, privacy, top5 cap and most-played-role behavior need no algorithm change for the proposed tier update.")

section("H. Drift, rounding and floors")
table(["Scenario / current K", "Mean net drift per player", "Mean total mixed-K/size drift", "Mean total rounding drift", "Mean floor drift"],
      [[scenario_names[key], number(value["configurations"]["current"]["metrics"]["totalDrift"] / value["metadata"]["populationSize"], 2),
        number(value["configurations"]["current"]["metrics"]["mixedKDrift"], 2),
        number(value["configurations"]["current"]["metrics"]["roundingDrift"], 2),
        number(value["configurations"]["current"]["metrics"]["floorDrift"], 2)] for key, value in summary.items()],
      "Per-player denominator = full synthetic community. Total drift components are run means. All accounting identities were checked.")
p("For equal-size teams with identical K, unrounded changes sum to zero. In general, total unrounded change is (sum K_A − sum K_B) × (actual_A − expected_A). Mixed progression stages—and6/7 teams even with equal individual K—are not zero-sum. This does not automatically mean long-run inflation: expected drift is zero if win probabilities are correctly calibrated, but finite samples and model mismatch can move the mean.")
p("Round-half-up can bias exact half-point ties; measured rounding drift was small in these runs. A zero floor can add positive drift when losses would go below zero; no clipping occurred in these ordinary simulations, while dedicated boundary tests prove the existing floor works. An800 floor would be materially different: it would prevent weaker ratings, distort ordering and create upward bias. Do not add it.")
p("These results do not demonstrate runaway inflation or deflation. They also cannot exclude long-run drift over seasons, changing skill distributions, manual adjustments or other outcome models. Track cohort mean, counts, K cohorts and audit completeness after launch; do not silently normalize player ratings.")

section("I. Proposed Iron-start tier policy — labels only")
p("Recommend these fixed display thresholds as a starting policy for approval. Bronze begins50 above baseline; subsequent tiers span150, equivalent to three50-point divisions. This gives more visible progression than the existing300-point upper tiers without putting a complete tier inside one ordinary veteran win. It is not calibrated to force specified population percentages, and the simulation does not validate an external meaning for labels such as Masters.")
table(["Tier", "Proposed ELO range", "Divisions if retained"],
      [["Iron", "0–849", "Iron3:0–599; Iron2:600–699; Iron1:700–849"],
       ["Bronze", "850–999", "3:850–899; 2:900–949; 1:950–999"],
       ["Silver", "1000–1149", "3:1000–1049; 2:1050–1099; 1:1100–1149"],
       ["Gold", "1150–1299", "3:1150–1199; 2:1200–1249; 1:1250–1299"],
       ["Platinum", "1300–1449", "3:1300–1349; 2:1350–1399; 1:1400–1449"],
       ["Diamond", "1450–1599", "3:1450–1499; 2:1500–1549; 1:1550–1599"],
       ["Masters", "1600+", "No division"]])
p("Under this proposal a new player is public-tier Iron and profile-rank Iron1 at800; it preserves existing lower Iron division boundaries. If the desired private profile label is specifically Iron3 rather than merely the Iron tier, approve a different Iron division mapping first. That remains a display-only choice.")
table(["Checkpoint, current K", "Mapping", "Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Masters"],
      [[n, label, *[number(x) for x in configs["current"]["checkpoints"][str(n)]["tierCounts"][mapping]]]
       for n in [10, 30, 50, 100] for mapping, label in [("current", "Existing"), ("iron850", "Proposed")]],
      "Mean eligible player counts across main seeds; opt-in is assumed for distribution reporting, not a privacy change. No population quotas.")
p("Around100 regular appearances the current experiment's strongest skill group averaged968 and run maxima averaged1151. The proposed policy therefore puts many players in Iron/Bronze, some in Silver, very few in Gold, and none in the higher three tiers in this experiment. That is an honest consequence of relative ELO and the tested skill range, not a reason to manufacture inflation.")
p("Gold1150 is already a demanding mark here; Platinum1300, Diamond1450 and Masters1600 are stretch thresholds, not demonstrated routine outcomes by100 matches. No responsible calendar estimate for Masters can be inferred from these runs. Wider actual skill differences, stronger outcome signal or many more informative matches might make them reachable; they may also remain empty in a bounded social cohort.")
p("Two balanced veteran wins add roughly20; a3–4 game Saturday can change an individual by roughly30–40 in an all-win/all-loss sequence, and placement wins at even odds add30 each. Such arithmetic illustrates label distances, not expected promotion speed. Merely attending does not guarantee leaving Iron: ratings are relative, so an average-strength player near800 can remain there indefinitely.")
p("What changes mathematically? Nothing. Starting800 is already current; threshold changes only change rank_for_elo/tier labels, rank-transition text and advertised ranges. Expected score still uses400, K remains four-stage, private ratings remain exact, and team construction still uses the same ELO values. A different K, score weighting, floor, role strength model or baseline population update would be a separate algorithm/policy decision.")

section("J. Integrity findings and limitations")
bullet([
    "Legacy counter disagreement: every current player has more completed appearances than the stored K counter. Public placement is correct by history, while K can still be in an earlier progression stage. Fresh empty launch data resolves that going forward; do not rewrite this data as part of the audit.",
    "Schema compatibility: elo_history.k_used CHECK currently permits only20/32/40/60. A64/24 or48/24 implementation would fail the audit insert unless the constraint is safely migrated. Deleting player rows does not remove that CHECK. A synthetic64 insert was rejected as expected.",
    "Unaudited admin rating edits: an isolated test completed a result, manually added100 to one rating through the existing admin edit route, then reversed the match. Reversal restored the recorded pre-match rating and overwrote that intervening admin edit. Either restrict manual rating adjustments after results or audit/order them properly before relying on such mixed workflows. No change made.",
    "6/7 objective mismatch: full Auto minimizes team TOTAL ELO after role assignment; result probability compares team AVERAGE ELO. Equal totals imply unequal averages at different team sizes. In eight full13-player validation cases the average-rating gap averaged about136 despite optimized totals; the proxy differs substantially. Whether libero contributions should be counted equally is a volleyball-domain choice, not something this audit can infer. Review before treating13-player ratings as calibrated.",
    "Volleyball role effects, exceptional single-player carry, lineups, changing ability, score-margin signal and deliberate manipulation are not observed here. The role-weighted and repeated-lineup sensitivities are illustrative, not fitted to club results.",
    "The long full-balancer study is12-player only. Actual13/14 validation is limited to eight sampled rosters per size. The14-player long-run proxy supports robustness checks, not a proof about full14-player Auto behavior.",
    "Five full-balancer seeds are modest. Approximate paired t intervals are descriptive and not corrected for testing many models; no general superiority claim is warranted.",
    "Placement and match-count displays intentionally use completed history while K uses a stored counter. This is consistent on fresh data, but imports/manual database edits must maintain both or explicitly reconcile them in a separate approved process.",
    "Exact rank strings already stored on historic audits should remain historic. If old data is retained despite the fresh-start plan, decide on policy versioning rather than silently rewriting old rank labels.",
])

section("K. Future implementation plan — no implementation authorized yet")
table(["Priority", "Files / functions", "Proposed action / migration"],
      [["Essential only if Iron-start proposal is approved",
        "artifacts/api-server/rating_progression.py — RANK_THRESHOLDS; existing rank_for_elo, tier_for_elo, tier_elo_ranges consumers",
        "Change threshold constants only. Keep800,10, K function and formula. No database schema migration required for labels; empty launch history avoids historic-policy ambiguity."],
       ["Essential regression coverage for approved thresholds",
        "artifacts/api-server/tests/test_rating_progression.py and tests/test_privacy.py; frontend tests/rank-display.test.mjs",
        "Update expected labels/ranges; test every boundary, Masters without division,800→Iron, ten-match placement and public whitelist. Preserve expected numeric rating updates."],
       ["Consumer verification, not automatic rewrite",
        "artifacts/api-server/app.py — serialize_player, get_leaderboard, submit_match_result; src/App.tsx and components/RankBadge.tsx",
        "Verify they consume shared derived ranks/ranges; no calculation, matchmaking, permissions or unrelated UI changes needed."],
       ["Optional separate data-integrity safeguard",
        "artifacts/api-server/app.py — update_player and reverse_match_result; backend reversal tests",
        "Approve a policy for admin numeric edits after matches: reject unsafe edits or introduce properly ordered adjustment audits. Preserve exact result reversal. Scope migrations separately if needed."],
       ["Investigate before any algorithm change",
        "src/match-balancing.ts — buildMatchTeams/balanceAssignedTeams; app.py — calculate_elo_updates",
        "Confirm intended6/7/libero strength semantics; then validate compatible total/average/core expectations in isolation. No balancer or ELO change recommended without domain approval."],
       ["Only if a two-stage candidate is later chosen",
        "rating_progression.py — k_for_matches; app.py — initialize_database audit CHECK; model tests",
        "Expand allowed historical/new K safely. SQLite cannot simply ALTER an existing CHECK; use a tested transactional table-copy/rebuild preserving rows/indexes, or an approved equivalent migration. Never retroactively recalculate historical K."],
       ["Club launch reset", "Existing admin/reset workflow, initiated by the user",
        "User-controlled fresh data only after backups/review. This audit does not delete players, matches, audits or accounts, and does not publish."]])

section("L. Verification and reproducibility")
table(["Check", "Result"], [
    ["Existing Flask suite", "73 tests passed; temporary databases; default global app initialization suppressed."],
    ["Existing real balancer suite", "26 tests passed; original algorithm unchanged."],
    ["Arithmetic parity", "1,000 synthetic Python/JavaScript fixtures passed; sizes6/6,6/7,7/7; mixed counters and ratings."],
    ["Boundary model checks", "K stage boundaries, expected-win direction and zero floor passed."],
    ["Concurrent result submission", "One200 and one409; exactly12 result audit rows; every count incremented once."],
    ["Exact restoration / schema probes", "Synthetic reversal restored ratings/counters; candidateK64 rejected by current schema; admin-edit overwrite risk reproduced."],
    ["Reproducibility", "Identical seed inputs reproduce every non-timing simulation output exactly."],
    ["Simulation integrity", "All500 requested runs and checkpoints complete; no negative ratings; all drift identities checked."],
    ["App/source/database isolation", f"{evidence['original_files_checked']} pre-existing file hashes checked: no original application source or local SQLite bytes changed."],
    ["Deployment", "None. No production connection, schema migration, data reset or algorithm deployment."],
])
p("Audit-only additions live under audits/elo-launch: model.mjs, run-sim.mjs, audit_checks.py, check-model.mjs, integrity_checks.py, validate-proxy.mjs, summarize.py, render_report.py, results/*.json / *.json.gz and comparison.csv. Raw simulation outputs are losslessly compressed; summary scripts accept compressed or uncompressed files. This HTML contains no external scripts, styles, fonts or images. CSV contains seed/configuration checkpoint aggregates from synthetic data only.")
parts.append("<pre>" + escape("""# Safely extracted arithmetic and isolated existing backend tests:
python audits/elo-launch/audit_checks.py --tests
node audits/elo-launch/check-model.mjs
python audits/elo-launch/integrity_checks.py

# Primary full Auto comparison:
node --experimental-strip-types audits/elo-launch/run-sim.mjs --engine=actual --size=12 --seeds=5 --target=100 --output=audits/elo-launch/results/actual-12-400.json

# Representative sensitivity; other flags: --scale=200, --model=role_weighted,
# --repeated=true, --size=13, --population=30 or50, --engine=random
node --experimental-strip-types audits/elo-launch/run-sim.mjs --engine=proxy --size=14 --seeds=20 --target=100 --output=audits/elo-launch/results/proxy-14-400.json
node --experimental-strip-types audits/elo-launch/validate-proxy.mjs
python audits/elo-launch/summarize.py
python audits/elo-launch/render_report.py""") + "</pre>")
p("Approval requested: retain the four-stage calculation; decide on the proposed Iron-start display thresholds and division label; separately prioritize any integrity safeguards. None of those recommendations has been applied.")

document = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wyndham Wombats VC — ELO Launch Audit</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:#172a42;font:16px/1.65 system-ui,-apple-system,sans-serif}
main{max-width:1180px;margin:32px auto;padding:32px 40px;background:white;border:1px solid #dce2ea;border-radius:16px}
h1{font-size:32px;line-height:1.2;margin:8px 0 16px}h2{font-size:23px;margin:40px 0 12px;padding-top:18px;border-top:1px solid #dce2ea}
p{margin:12px 0}.eyebrow{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#5f6f82}.notice{padding:14px 18px;background:#fff7dc;border-left:4px solid #c89527;border-radius:4px}
.caption{font-size:13px;color:#526377}.table-wrap{overflow-x:auto;margin:16px 0;border:1px solid #dce2ea;border-radius:8px}table{border-collapse:collapse;width:100%;font-size:14px}
th{text-align:left;color:#fff;background:#203b5b;white-space:normal}td,th{padding:12px 14px;vertical-align:top;border-bottom:1px solid #dce2ea}tbody tr:nth-child(even){background:#f7f9fc}tbody tr:last-child td{border-bottom:0}
ul{padding-left:24px}li{margin:9px 0}pre{font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:#eef2f7;border-radius:8px}
footer{font-size:13px;color:#526377;margin-top:28px}@media(max-width:640px){main{margin:0;padding:22px 16px;border-radius:0;border:0}h1{font-size:27px}h2{font-size:21px}td,th{padding:9px;font-size:12px}}
@media print{body{background:white}main{margin:0;padding:0;border:0}h2{break-after:avoid}tr{break-inside:avoid}.table-wrap{overflow:visible}}
</style></head><body><main><div class="eyebrow">Wyndham Wombats VC · Analysis only · 8 October 2026</div>
<h1>ELO system audit & isolated simulations</h1>
<div class="notice"><strong>Recommendation:</strong> retain four-stage K progression.
Change the starting tier to Iron only through approved display thresholds. No club data or application algorithm changed.</div>
""" + "".join(parts) + """<footer>Prepared for review before implementation. Synthetic results are evidence under stated assumptions, not a forecast or guarantee of real player outcomes.</footer></main></body></html>"""
(ROOT / "elo-launch-audit.html").write_text(document)
print(f"Report written: {ROOT / 'elo-launch-audit.html'} ({len(document):,} characters)")
