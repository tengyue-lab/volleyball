---
name: Manual Lock and Fill rules
description: User-resolved lock capacity and unlocked-player movement semantics.
---

Manual locks use the required formation's per-role capacity, not a blanket one-lock-per-role rule: two Outside Hitters or Middle Blockers may be locked on the same team.

**Why:** The user explicitly chose “Use formation capacity” to resolve contradictory wording in the original Lock + Fill brief.

**How to apply:** Reject locks exceeding the role's capacity, including Libero constraints for six- versus seven-player sides. Do not reintroduce a ban on all same-role locks.

Fill may move manually placed unlocked players between teams. Only locked players have both a fixed team and position.

**Why:** The user explicitly chose “Allow Fill to move unlocked players.”

**How to apply:** Treat unlocked manual placement as provisional, not a hard team constraint. Fill and later ELO balancing must never move or reassign locked players.

Manual Swap changes only team membership. Pending roles must remain pending; explicit locked positions travel with their players. Swaps must work with partial teams and an unassigned selected-player pool.

**Why:** The user corrected automatic role assignment during manual swaps and explicitly prohibited assignment, Fill, balancing, and full-roster requirements in this action.

**How to apply:** Keep manual swaps separate from generated role plans. Use opposite-team membership and lock compatibility, not roster completeness, to determine candidates. Do not revive generated roles from saved rosters after a swap.
