---
name: Vite runtime dependency consistency
description: Installed React versions can match while Vite serves an older prebundled runtime.
---

Treat installed package versions and Vite's prebundled browser runtime as separate evidence when diagnosing a React version mismatch.

**Why:** A web-only React patch left the installed React/ReactDOM pair consistent, but an ordinary server restart continued serving an older optimized ReactDOM. Changing the working package pair again would have addressed the wrong cause.

**How to apply:** If the installed pair matches but the browser reports different versions, inspect the optimized dependency sources before changing packages or the shared workspace catalog. A stale optimizer cache is not proof that the dependency declarations are wrong.
