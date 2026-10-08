"""Read source safely, parity-check the synthetic mirror, run isolated tests.

Never import the real app module with its default app initialization. Source is
compiled into a separate in-memory module with global app initialization removed.
"""
import ast
import hashlib
import json
import math
from pathlib import Path
import random
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "artifacts/api-server"


def isolated_app(default_path):
    tree = ast.parse((API / "app.py").read_text())
    tree.body = [
        node for node in tree.body
        if not (isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "app" for target in node.targets))
    ]
    module = types.ModuleType("app")
    module.__file__ = str(API / "app.py")
    sys.path.insert(0, str(API))
    sys.modules["app"] = module
    exec(compile(tree, module.__file__, "exec"), module.__dict__)
    module.DEFAULT_DATABASE = Path(default_path)
    return module


def parity_cases(module):
    rng = random.Random(20261008)
    cases = []
    for i in range(1000):
        a_size, b_size = rng.choice([(6, 6), (6, 7), (7, 7)])
        players = [{
            "id": j + 1, "elo": rng.randrange(0, 3001),
            "matchesPlayed": rng.choice([0, 9, 10, 29, 30, 59, 60, 100]),
        } for j in range(a_size + b_size)]
        a, b = players[:a_size], players[a_size:]
        winner_a = bool(i % 2)
        expected = module.calculate_elo_updates(a, b, "Team A" if winner_a else "Team B")
        cases.append({"a": a, "b": b, "winnerA": winner_a, "expected": expected})
    destination = Path("/tmp/elo-audit-parity.json")
    destination.write_text(json.dumps(cases))
    print(f"Wrote {len(cases)} baseline parity fixtures to {destination}")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="elo-audit-unit-") as temp:
        module = isolated_app(Path(temp) / "unused-default.sqlite3")
        parity_cases(module)
        if "--tests" in sys.argv:
            sys.path.insert(0, str(API / "tests"))
            suite = unittest.defaultTestLoader.discover(str(API / "tests"))
            result = unittest.TextTestRunner(verbosity=1).run(suite)
            if not result.wasSuccessful():
                raise SystemExit(1)
