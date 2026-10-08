"""Aggregate only synthetic output; the current club aggregate stays separate."""
import csv
import gzip
import json
from pathlib import Path
import statistics as st

ROOT = Path(__file__).resolve().parent
LABELS = {"current": "Four-stage 60/40/32/20", "two64_24": "Two-stage 64/24",
          "two48_24": "Two-stage 48/24", "two64_32": "Two-stage 64/32"}
TIERS = ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Masters"]
THRESHOLDS = {
    "current": [0, 800, 1100, 1400, 1700, 2000, 2300],
    "iron900": [0, 900, 1050, 1200, 1350, 1500, 1650],
    "iron850": [0, 850, 1000, 1150, 1300, 1450, 1600],
}

def read_json(path):
    if path.exists():
        return json.loads(path.read_text())
    with gzip.open(str(path) + ".gz", "rt") as source:
        return json.load(source)


def mean(values):
    v = [x for x in values if x is not None]
    return st.mean(v) if v else None


def ci(values):
    v = [x for x in values if x is not None]
    m = mean(v)
    if len(v) < 2:
        return [m, m]
    # Approximate t intervals; label them explicitly, small seed counts are not
    # evidence of general superiority under unknown real-world outcome models.
    critical = {5: 2.776, 10: 2.262, 20: 2.093}.get(len(v), 1.96)
    half = critical * st.stdev(v) / len(v) ** 0.5
    return [m - half, m + half]


def grouped_snapshot(runs, n):
    snapshots = [r["snapshots"][str(n)] for r in runs]
    keys = ["session", "totalMatches", "population", "regularMedianMatches", "allMedianMatches",
            "lowMedianMatches", "minMatches", "eligible", "min", "median", "max", "mean", "sd", "rho", "pairAccuracy"]
    result = {key: mean(s[key] for s in snapshots) for key in keys}
    result["rho_ci"] = ci([s["rho"] for s in snapshots])
    result["rho_by_seed"] = [s["rho"] for s in snapshots]
    result["groupRatings"] = [mean(s["groupRatings"][g] for s in snapshots) for g in range(5)]
    result["tierCounts"] = {}
    for name, thresholds in THRESHOLDS.items():
        counts = []
        for snapshot in snapshots:
            c = [0] * 7
            for p in snapshot["players"]:
                if p["matchesPlayed"] < 10:
                    continue
                index = max(i for i, threshold in enumerate(thresholds) if p["elo"] >= threshold)
                c[index] += 1
            counts.append(c)
        result["tierCounts"][name] = [mean(c[i] for c in counts) for i in range(7)]
    result["bins"] = {str(low): mean(sum(low <= p["elo"] < low + 100 for p in s["players"]) for s in snapshots)
                      for low in range(300, 1900, 100)}
    return result


def summarize(path):
    data = read_json(path)
    metadata, runs = data["metadata"], data["results"]
    assert len(runs) == metadata["seedCount"] * 4, f"Incomplete run set: {path}"
    result = {"metadata": metadata, "configurations": {}, "paired": {},
              "simulatedMatches": sum(r["snapshots"][str(metadata["target"])]["totalMatches"] for r in runs)}
    for configuration in LABELS:
        subset = [r for r in runs if r["configuration"] == configuration]
        result["configurations"][configuration] = {
            "label": LABELS[configuration],
            "checkpoints": {str(n): grouped_snapshot(subset, n) for n in metadata["checkpoints"]},
            "metrics": {key: mean(r["metrics"][key] for r in subset) for key in subset[0]["metrics"]},
        }
        players = [p for r in subset for p in r["finalPlayers"] if p["matchesPlayed"] > 0]
        for group, predicate in [
            ("regular", lambda p: not p["newcomer"] and not p["lowAttendance"]),
            ("lowAttendance", lambda p: p["lowAttendance"]),
            ("newcomer", lambda p: p["newcomer"]),
        ]:
            selected = [p for p in players if predicate(p)]
            errors = [p["elo"] - p["skill"] for p in selected]
            result["configurations"][configuration][group] = {
                "meanMatches": mean(p["matchesPlayed"] for p in selected),
                "meanElo": mean(p["elo"] for p in selected), "meanLatentSkill": mean(p["skill"] for p in selected),
                "anchoredMeanError": mean(errors), "anchoredMAE": mean(abs(x) for x in errors),
                "meanWinRate": mean(p["winRate"] for p in selected),
            }
        milestones = [p for r in subset for p in r["individualCheckpoints"]]
        result["configurations"][configuration]["individualMilestones"] = {
            str(n): {
                "appearancesRecorded": sum(p["count"] == n for p in milestones),
                "meanElo": mean(p["elo"] for p in milestones if p["count"] == n),
                "groupRatings": [mean(p["elo"] for p in milestones if p["count"] == n and p["group"] == g) for g in range(5)],
            } for n in metadata["checkpoints"]
        }
    by_key = {(r["configuration"], r["seed"]): r for r in runs}
    for candidate in ("two64_24", "two48_24", "two64_32"):
        diffs = [by_key[("current", seed)]["snapshots"][str(metadata["target"])]["rho"]
                 - by_key[(candidate, seed)]["snapshots"][str(metadata["target"])]["rho"]
                 for seed in range(1, metadata["seedCount"] + 1)]
        result["paired"][candidate] = {"rho_current_minus_candidate": mean(diffs), "approx_95_ci": ci(diffs),
                                      "seeds_current_higher": sum(x > 0 for x in diffs), "seed_differences": diffs}
    return result


if __name__ == "__main__":
    files = ["actual-12-400", "proxy-14-400", "proxy-14-200", "proxy-14-roles", "proxy-14-repeated",
             "proxy-13-400", "proxy-30players", "proxy-50players", "random-14-400"]
    summary = {name: summarize(ROOT / f"results/{name}.json") for name in files}
    (ROOT / "results/summary.json").write_text(json.dumps(summary, indent=2))
    rows = []
    for name in files:
        data = read_json(ROOT / f"results/{name}.json")
        for run in data["results"]:
            for n, snap in run["snapshots"].items():
                rows.append({"scenario": name, "configuration": run["configuration"], "seed": run["seed"], "checkpoint": n,
                             **{k: v for k, v in snap.items() if isinstance(v, (int, float))}})
    with (ROOT / "results/comparison.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({name: {cfg: {"rho100": round(values["checkpoints"]["100"]["rho"], 3),
                                 "sat30plus": round(values["metrics"]["sessionMeanAbsChange"], 1),
                                 "veteran": round(values["metrics"]["veteranMeanAbsChange"], 1)}
                           for cfg, values in dataset["configurations"].items()} for name, dataset in summary.items()}, indent=2))
