---
name: Workflow restart ordering
description: Environment rebuild contention during heavy verification can trigger otherwise healthy service startup timeouts.
---

Finish heavy verification before restarting the managed API and web services; restart those services sequentially in this workspace.

**Why:** Concurrent restarts during backend tests and frontend builds produced an API startup deadline failure and a frontend environment-rebuild timeout. Both unchanged services started successfully when restarted sequentially after verification.

**How to apply:** Do not change ports or authentication architecture merely because that timeout occurred. Inspect logs, let active verification finish, and retry the existing managed services sequentially before diagnosing a code failure.
