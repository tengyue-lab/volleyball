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

The public social leaderboard should show rank tier only (not numbered places), player name and provisional status, without numeric ELO or preferences. Public-leaderboard visibility requires explicit opt-in and defaults OFF for new players; exact numeric ELO and division rank are visible only to the linked player owner and admins, including through player list/detail API responses. Match-history ELO information is admin-only, enforced in API responses as well as the UI. Players navigation and the Players page are admin-only; the normal user's own Profile must remain available.

**Why:** The user explicitly requested these public-display restrictions, clarified that leaderboard rank means tier only, specified that exact ELO belongs only on the linked player's own Profile or an admin view, and required players to remain private until they opt in.

**How to apply:** Preserve leaderboard ranking calculations and the user's own current Profile access. Keep opt-in as leaderboard eligibility, set new players to private unless they explicitly opt in, and mask other players' exact ELO and division rank server-side. Restrict public display/data responses without changing stored ratings, authentication architecture, or result/deletion/reversal behavior.

An opted-in player becomes public-leaderboard eligible after at least one completed match. Players with 1–9 completed matches rank normally among established players and show as Provisional; players with zero completed matches remain excluded.

**Why:** The user approved displaying provisional players in the same ELO order but explicitly chose to keep unplayed accounts hidden until their first completed match.

**How to apply:** Filter out zero-appearance players before assigning top-five placements, then sort all remaining public players with the existing ELO tie-breaks and derive provisional status from the existing ten-match threshold.

Any signed-in account linked to a player may update preferred positions for its own linked player, including admin accounts. Profile preference updates must derive the target player from verified account linking; admin player-management edits remain a separate capability.

**Why:** The user explicitly requested self-service preference editing for linked admins while preserving admin management in the Players tab and preventing a profile editor from targeting another player's record.

**How to apply:** Keep a Profile-specific preference update bound to the verified account's linked player ID. Do not use admin status to select a different target; keep the existing admin Players editor on its admin-authorized path.
