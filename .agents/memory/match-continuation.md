---
name: Match continuation decisions
description: Why next-match carry-forward copies membership but uses live ratings and remains memory-only.
---

Carry forward the played pool, not the previous teams, assignments, locks, ratings or priority state. Use current player profiles and ratings to build the next match.

**Why:** The user wants to reuse who played, while completed matches can change ELO and preferred-role priority. Reusing the old ratings or assignments would bypass those updates and unintentionally preserve the previous teams.

**How to apply:** Keep the carried membership independent of later edits/reversals of the source match. Compare identity/preferences for warnings, not normal rating, rank, counter or priority changes.

Creation-session state is intentionally memory-only and cleared on account/access changes.

**Why:** The approved scope requires continuity across navigation and filter changes, but excludes unrelated draft persistence. Storing private ratings or whole results in browser storage would also extend the privacy boundary.

**How to apply:** Treat reload recovery as a separately scoped feature, not an implied guarantee. If persistence is requested later, scope it to the signed-in admin and avoid storing ratings or audits.
