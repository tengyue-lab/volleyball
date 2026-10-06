---
name: ELO privacy scope
description: User-approved authentication exception for enforcing private ratings.
---

For the ELO privacy feature, the user chose “Full privacy with sign-in,” including account-to-player ownership and administrator access, rather than leaderboard-only filtering.

**Why:** The original brief said not to change authentication, but the app had no way to identify owners or administrators. The user explicitly approved adding sign-in to enforce real privacy after this conflict was explained.

**How to apply:** Treat authentication and ownership as approved scope for this feature. Do not reduce privacy to hidden UI labels or leaderboard filtering while leaving private ratings accessible through public responses.

Clerk is the required authentication provider. Its layer only gates access; it must not replace the existing Flask domain routes for players, matches, matchmaking or ELO.

**Why:** The user explicitly clarified that adding authentication must preserve the existing domain backend.

**How to apply:** Keep Flask authoritative for its current domain routes and preserve existing matchmaking logic. Any authentication transport adapter must remain limited to verified identity and access gating.

“Do not publish automatically. Deployment is my action.”

**Why:** The user explicitly reserved publishing this app for themselves.

**How to apply:** Finish and verify changes in preview without publishing automatically.
