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

The public social leaderboard should show rank tier only (not numbered places), player name and provisional status, without numeric ELO or preferences. Public-leaderboard opt-in controls eligibility only; exact numeric ELO and division rank are visible only to the linked player owner and admins, including through player list/detail API responses. Match-history ELO information is admin-only, enforced in API responses as well as the UI. Players navigation and the Players page are admin-only; the normal user's own Profile must remain available.

**Why:** The user explicitly requested these public-display restrictions, clarified that leaderboard rank means tier only, and specified that exact ELO belongs only on the linked player's own Profile or an admin view.

**How to apply:** Preserve leaderboard ranking calculations and the user's own current Profile access. Keep public opt-in as leaderboard eligibility, but mask other players' exact ELO and division rank server-side. Restrict public display/data responses without changing stored ratings, authentication architecture, or result/deletion/reversal behavior.
