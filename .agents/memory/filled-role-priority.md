---
name: Filled-role priority
description: Clarified ranked-matchmaking fallback and completion-based compensation rules.
---

Ranked matchmaking must retain Filled assignments for ordinary positional shortages, with the best available player by ELO, an orange Filled badge, and a warning listing short positions. This supersedes the original ranked-preferences brief's prohibition on unselected-role fallback. A pool with no Setter-capable player is the stated blocking exception.

**Why:** The user corrected the initial task draft to explicitly retain Filled fallback rather than reject shortage pools.

**How to apply:** Distinguish intentional Filled roles from Preferred roles in matchmaking, saved assignments, API validation, warnings, and tests. Do not reintroduce a blanket selected-roles-only restriction.

Preferred-role priority is granted after a completed Filled assignment and cleared after a later completed Preferred assignment. Saving an upcoming roster neither grants nor consumes priority. Reopening a result must reverse its priority effects safely.

**Why:** The user explicitly chose match completion as the priority transition point.

**How to apply:** Base priority on actual completed-match assignment history, preserve existing roster snapshots, and verify completion and reversal transitions. Display "Priority: Preferred role next match" while active; resolve competing priority players by ELO, then oldest outstanding Filled assignment.

Do not infer historical played roles by running the new matcher over old preferences. Recover compensation only when explicit saved roles and actual completion audit order are available.

**Why:** Older completed rosters in this project can contain preferences without any recorded played role. Recomputing with today's ranking rules would invent history and could grant the wrong player priority.

**How to apply:** Leave ambiguous historical snapshots unchanged. Order recovered compensation by actual completion history, not when recovery rows were inserted or when the roster was created.
