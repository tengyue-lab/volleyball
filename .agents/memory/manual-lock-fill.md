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

Manual Swap changes only team membership and must neither generate nor discard roles. Before Fill, pending players remain pending and swaps work with partial teams and an unassigned selected-player pool. Explicit locked positions travel with their players.

After Fill or other existing role assignment, swap candidates must have the same assigned role on the opposite team. Preserve all role records, including unrelated players' roles. Use the same assigned-role compatibility rule as automatic teams.

**Why:** The user distinguished pending-role swaps from post-Fill swaps: pending roles must not be generated, while existing Fill roles must not reset to pending.

**How to apply:** Keep manual swaps separate from role generation and balancing. Before role assignment use lock compatibility; after assignment use same-role compatibility and carry the existing roles with their players.

Clear Roles removes both manual locks and Fill-generated roles, leaving team membership, the selected player pool, and the Teams step unchanged. It must be available whenever any role exists, even without manual locks. Clear Selection keeps its separate existing behavior.

**Why:** The user replaced Clear Locks with Clear Roles so generated and manually assigned roles can both be reset deliberately.

**How to apply:** Only the explicit Clear Roles action should reset existing roles. Do not revive saved generated roles after clearing them; Fill may be used again afterward.
