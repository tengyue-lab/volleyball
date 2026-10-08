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

Launch improvements must preserve existing player records, numeric ratings and match history. New players should start at 800 ELO in the Iron tier.

**Why:** After reviewing the audit, the user explicitly prohibited resetting or deleting existing data and approved an Iron starting tier without changing numeric ratings.

**How to apply:** Use the audit's explicitly recommended tier mapping after verification. Keep old audit history intact. Request approval before historical counter repairs or significant rating-audit migrations. Do not deploy.

ELO represents continuous relative skill, not guaranteed rank progression. Keep the existing four-stage K progression and starting ELO 800; do not add seasonal resets, attendance rewards or seasonal inflation.

**Why:** The user explicitly approved retaining the four-stage system and rejected four-month resets and attendance-based ELO rewards.

**How to apply:** Separate display-tier changes from numeric rating changes. Seasonal statistics, if requested later, must not implicitly reset or inflate ELO.

Do not change the team balancer while implementing the ELO launch improvements. The total-team balancing versus team-average result expectation issue belongs to a separate review.

**Why:** The user explicitly deferred the unequal-team-size concern to the next team-balancer stage.

**How to apply:** Preserve role assignment, preference rules, formations and match generation until separately approved.
