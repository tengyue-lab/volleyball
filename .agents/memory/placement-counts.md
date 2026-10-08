---
name: Placement from completed history
description: Separate displayed placement eligibility from ELO's stored K-factor counter when older counters lag.
---

Use completed match roster appearances to determine displayed match counts, provisional status and established-player leaderboard eligibility. Keep the persisted counter used for K-factor progression unchanged unless the user approves an ELO progression change.

**Why:** Older player counters can undercount completed roster appearances; using them for placement falsely keeps players provisional. The user requested accurate placement without changing ELO calculations.

**How to apply:** Count each player once per completed match snapshot for display and eligibility. Leave the stored progression counter and its reversal behavior untouched.
