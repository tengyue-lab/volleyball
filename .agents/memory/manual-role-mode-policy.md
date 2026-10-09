---
name: Manual role-free match policy
description: No Roles Lock matches count for ELO but are entirely excluded from position history.
---

No Roles Lock matches are ordinary played matches for ELO, K-factor progression, and completed-match totals, but have zero effect on position rotation or role-compensation priority.

**Why:** The user explicitly separates rating history from position history. Unassigned appearances must not reset, dilute, or displace a player's last three eligible role-assigned appearances.

**How to apply:** Exclude explicit role-free matches before limiting rotation history, not after. Do not invent positions, preference ranks, Filled assignments, or compensation events; preserve null role metadata and the existing ELO result/reversal path.

Only an explicitly saved No Roles Lock mode identifies a role-free match. Do not infer it from missing role metadata in legacy history.

**Why:** Missing historical assignments may be unreliable legacy data, whose neutral appearance still occupies the existing rotation window. Reclassifying them as role-free would change past fairness semantics without approval.

**How to apply:** Leave legacy modes unknown and preserve their existing handling. Apply the role-free exclusion only to explicitly marked matches.
