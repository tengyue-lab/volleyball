---
name: Volleyball product context
description: User-stated match cadence, phone-first use, and Current Match semantics.
---

Players play roughly 3–4 matches per week.

**Why:** The user supplied this as product context for ELO progression and provisional placement.

**How to apply:** Use this cadence when estimating how long match-count-based placement or progression takes; do not assume players compete daily.

The app is used mostly on phones.

**Why:** The user explicitly supplied this usage context when requesting mobile-first navigation.

**How to apply:** Prioritize compact navigation, readable narrow layouts, and touch-friendly controls when changing the interface.

Current Match means all saved upcoming rosters, not only the newest roster. Admins may create several independent upcoming matches for one session from the same selected player pool; completing one leaves the others upcoming.

**Why:** The user chose “Show all upcoming rosters” when asked how the existing upcoming status should map to Current Match.

**How to apply:** Keep every upcoming match separately addressable and ordered using the existing Current Match ordering. Do not silently hide other unfinished rosters or introduce a separate active-match status without a new product decision.

For public launch, the user intends a fresh player database and empty match history, with all new players starting at the same baseline within Iron.

**Why:** The user supplied this launch direction for the ELO audit and simulation; candidate settings are for evaluation, not approved implementation.

**How to apply:** Evaluate launch recommendations against an equal Iron starting baseline. Do not delete data, change ratings or thresholds, or deploy without the user's separate approval.
