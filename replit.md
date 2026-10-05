# Volleyball Team Manager

A local-first volleyball roster and match setup app for managing player positions, ELO ratings, and upcoming team rosters.

## Run & Operate

- `pnpm --filter @workspace/volleyball-manager run dev` — run the web app
- `uv run python main.py` — run the Flask API from the project root
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm run typecheck:libs` — typecheck generated and shared libraries
- `pnpm --filter @workspace/volleyball-manager run typecheck` — typecheck the web app
- The API listens on `PORT` (8080 in its managed service).

## Stack

- Web: React + Vite with the generated API client
- API: Python 3.11 + Flask
- Database: SQLite at `artifacts/api-server/data/volleyball.sqlite3`
- API contract: OpenAPI 3.1 with Orval-generated client types and hooks

## Where things live

- `artifacts/volleyball-manager/src/App.tsx` — player, leaderboard, and match roster screens
- `artifacts/volleyball-manager/src/match-balancing.ts` — role assignment and same-role ELO team balancing
- `artifacts/volleyball-manager/src/index.css` — web app styles
- `artifacts/api-server/app.py` — Flask routes, validation, and SQLite schema
- `lib/api-spec/openapi.yaml` — source of truth for API routes and response types
- `main.py` — project-root entry point for the Flask service

## Architecture decisions

- SQLite is intentional; do not replace it with the workspace PostgreSQL database.
- Match rosters save player details and the assigned role as snapshots so later player edits or deletions do not rewrite a saved roster.
- The match builder supports manual assignment and exact role-first, same-role ELO balancing with post-balance swaps. Roles not listed on a profile may be Filled by the best available ELO player and are reported by role.
- Match result entry and rating changes remain deferred until Phase 4.

## Product

- Phase 1: create, view, edit, and delete players; positions are multi-select and new players start at ELO 1000; leaderboard sorts by ELO.
- Phase 2: create upcoming matches from 12, 13, or 14 selected players, with exact six-player roles (1 Setter, 2 Outside Hitters, 2 Middle Blockers, 1 Opposite). Seven-player sides add 1 assigned Libero role.
- Match creation supports a selected player pool, auto-balancing or manual assignment, Preferred/Filled role badges and shortage warnings, live team ELO totals/averages, and player swaps. For 13, auto-balance gives the Libero to the lower-ELO six-player core when possible.
- Scores are stored as null and are not editable until result entry is built.

## User preferences

- Keep the backend in Flask and the database in SQLite.
- Build the requested phases in order.

## Gotchas

- The API artifact runs from its service directory, so its managed command changes to the project root before invoking `uv`.
- Validate and replace artifact manifests through the artifact workflow; do not edit them directly.

## Pointers

- See the `artifacts` skill for artifact registration and workflow lifecycle.
- See the `pnpm-workspace` skill for workspace and API contract conventions.
