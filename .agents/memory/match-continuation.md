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

When several saved upcoming rosters exist, the admin explicitly chooses which roster the Create Match draft actions target. “Continue to Team Assignment” edits that saved draft in place, rather than creating a separate copy.

**Why:** The user selected explicit roster choice and in-place editing when asked to clarify the new Create Match actions.

**How to apply:** Keep this distinct from Next Game, which starts a new match using the latest completed match's eligible pool. Reset targets only the selected saved draft; other upcoming rosters remain, so Current Match becomes empty only when no upcoming rosters remain.

Admins must be able to delete unplayed drafts and completed matches. Completed deletion must first use the existing exact result reversal, restoring ELO, rank, matches played and priority. Remove the deleted match's associated audit rows only after that reversal, leaving no orphan records.

**Why:** The user explicitly requested safe completed-match deletion and no orphan audit rows. This supersedes the earlier rule that draft reset retained assignment metadata after deleting its match.

**How to apply:** Keep reversal and deletion atomic, preserve unrelated match audits, and retain existing later-result dependency safeguards. Do not confuse deletion eligibility with draft-edit eligibility or reverse an already-reversed result twice. Continue still retains recorded teams and positions, using live ratings without reassigning roles merely because names or ratings changed.
