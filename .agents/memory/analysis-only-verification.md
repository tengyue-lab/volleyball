---
name: Analysis-only verification
description: Isolation rule for audits and simulations that must not mutate the running app or club data.
---

For analysis-only work, isolate application bootstrap as well as each test's database fixture. Do not assume temporary per-test databases make the whole test process read-only.

**Why:** During the launch audit, ordinary backend imports would initialize the default SQLite database before temporary fixtures were created. The audit explicitly prevented that initialization and verified unchanged source and database fingerprints.

**How to apply:** Use a fully isolated copy or suppress/redirect bootstrap before loading the backend for analysis. Keep synthetic data separate, avoid live mutation endpoints, and compare pre-existing source and database fingerprints before delivery.
