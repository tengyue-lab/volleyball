---
name: Browser-test cleanup
description: Browser contexts can outlive the testing worker and recreate deleted QA accounts through background polling.
---

Close all authenticated and anonymous testing browser contexts before removing test-owned database fixtures, then verify there are no remaining QA rows.

**Why:** Testing worker completion did not close its browser contexts automatically. A still-authenticated page kept polling the account endpoint and recreated a QA account after cleanup, despite the worker's initial zero-residual check.

**How to apply:** Include context closure before transactional fixture cleanup in browser test instructions. Compare original records against a read-only baseline afterward. Remove only test-owned rows; never reset sequences or delete actual club records or users.

## Clerk test email domain

Use unique, lowercase QA addresses at `example.com` for programmatic Clerk test identities, rather than `example.test`.

**Why:** The test login helper rejected `example.test` addresses with HTTP 422 (“Email address must be a valid email address”) before issuing a sign-in URL; the same flow succeeded with `example.com`.

**How to apply:** Choose an accepted fixture domain in the test instructions. Do not change authentication configuration or use the real administrator identity to work around a rejected test address.

## Shared verification baselines

Put database verification baselines needed by a testing helper in the ignored workspace `.local/` directory, not `/tmp/`, and remove them after verification.

**Why:** A baseline written under `/tmp/` disappeared across runtime/worker boundaries and was unavailable to the browser tester, blocking safe fixture setup.

**How to apply:** Pass a workspace-relative baseline path to the tester. Keep it untracked, do not print its contents, and compare original rows before removing the baseline.
