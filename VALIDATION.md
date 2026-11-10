# Beta validation

Snapshot: Threadlamp **1.9.6 beta 1**, prepared November 9, 2026.

## Checks completed

- All **21** Node test files passed; no failures or skips (Node.js 18.20.4).
- All **41** JavaScript files passed syntax checks.
- The sanitized server-ready diagnostic fixture passed its targeted regression
  check after replacing an installation-specific example port.
- Offline dashboard interaction/layout checks passed with isolated Chromium
  profiles at requested window sizes **1440×960**, **1280×720** and **500×900**
  (Chromium 150.0.7871.181, Debian 12). Actual content viewport dimensions may
  differ from the window size. The compact layout breakpoint was extended to
  900px to keep the primary queue action visible in the intermediate viewport.
- The public source inventory and runtime reference checks passed: **71 source
  files**, **35 extension-package files**.
- Gitleaks 8.30.1 found no secrets in the prepared source. A separate sweep checked
  known private project references, local home paths and original chat identifiers.
- Packaging verifies each ZIP entry against its source and generates SHA-256
  checksums. An explicit inventory excludes Git metadata and local artifacts.
- After consolidating development into the main checkout, all 21 test files
  passed again. Release-guard checks confirmed local archives are skipped,
  private paths explicitly added to the inventory are rejected, and unknown
  source files still fail review. The installable ZIP remains byte-identical
  to the initially reviewed beta; source-only tooling and guidance were updated.

The dashboard fixture uses invented data and mocks Chrome APIs. It exercises
selection, queueing, replies, approvals, schedules, stale/offline guards, dialogs,
keyboard/focus behavior and large-list layout without contacting real services.

## Not yet established

No live authenticated ChatGPT run, phone notification, real project-server event
or live quota-limit encounter was performed for this beta. Those checks remain
in the [release checklist](RELEASE_CHECKLIST.md). Existing browser sessions and
the development extension were not reloaded or modified.

Secret scanning is evidence about detectable patterns, not a guarantee that all
sensitive material or every security defect is absent. Source inspection cannot
establish copyright ownership or provide trademark clearance.
