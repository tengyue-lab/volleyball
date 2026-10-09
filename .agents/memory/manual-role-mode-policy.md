---
name: Manual role-free match policy
description: No Roles Lock matches count for ELO but are entirely excluded from position history.
---

No Roles Lock matches are ordinary played matches for ELO, K-factor progression, and completed-match totals, but have zero effect on position rotation or role-compensation priority.

**Why:** The user explicitly separates rating history from position history. Unassigned appearances must not reset, dilute, or displace a player's last three eligible role-assigned appearances.

**How to apply:** Exclude explicit role-free matches before limiting rotation history, not after. Do not invent positions, preference ranks, Filled assignments, or compensation events; preserve null role metadata and the existing ELO result/reversal path.
