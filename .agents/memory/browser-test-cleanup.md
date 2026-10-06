---
name: Browser-test cleanup
description: Browser contexts can outlive the testing worker and recreate deleted QA accounts through background polling.
---

Close all authenticated and anonymous testing browser contexts before removing test-owned database fixtures, then verify there are no remaining QA rows.

**Why:** Testing worker completion did not close its browser contexts automatically. A still-authenticated page kept polling the account endpoint and recreated a QA account after cleanup, despite the worker's initial zero-residual check.

**How to apply:** Include context closure before transactional fixture cleanup in browser test instructions. Compare original records against a read-only baseline afterward. Remove only test-owned rows; never reset sequences or delete actual club records or users.
