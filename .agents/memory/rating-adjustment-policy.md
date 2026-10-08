---
name: Rating adjustment semantics
description: Approved delta preservation and fail-closed handling of ambiguous historical ratings.
---

Admin rating edits become adjustment amounts relative to the rating when applied. Reversing a match preserves later adjustment amounts, not an absolute admin-entered target.

**Why:** The user approved this additive accounting approach so legitimate corrections survive removal of a match's contribution, without recalculating historical K.

**How to apply:** Preserve the recorded adjustment once across reopen, correction and deletion. Keep later-result dependency protection. Do not reinterpret an adjustment as a permanent absolute rating target without new approval.

Unknown legacy adjustments and reversals that would put the corrected rating below zero require review, rather than guessed historical events or silently clamped restoration.

**Why:** Preserving an adjustment exactly, preserving the match's exact recorded contribution and flooring ELO at zero cannot all be satisfied when the resulting restoration is negative. The user approved blocking that case.

**How to apply:** Leave all affected ratings, counters, matches and audits unchanged on conflict. Never fill historical audit gaps with invented adjustment records.
