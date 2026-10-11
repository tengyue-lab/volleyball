---
name: Database environment safety
description: Keep development PostgreSQL rehearsals separate from production database connections.
---

Use an explicitly development-scoped database connection for development migrations and rehearsals. If the execution environment reports production, stop; do not override that marker to reach a development database. Prefer the database tool's explicit development environment or a verified development workflow.

**Why:** A migration rehearsal was authorized only in development while the shell reported `REPLIT_ENVIRONMENT=production`; failing closed prevented a development backup from being imported into the wrong database.

**How to apply:** Before any database write, verify the connection target independently of the project name or intended task. Never print connection strings or weaken an environment guard to make a script run.
