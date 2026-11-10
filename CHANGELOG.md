# Changelog

## 1.9.6 beta 1

- First public beta preparation as Threadlamp by Phosphoros Research.
- Adds publisher branding, bundled application icons, MPL-2.0 licensing, privacy
  and support documentation, and explicit release packaging.
- Generalizes internal test-project names and omits private diagnostics and
  development/rollback records from the public source snapshot.
- Keeps existing automation, storage keys, backup format and server protocol
  identifiers compatible with the development baseline.
- Extends the compact dashboard layout to intermediate viewport heights so its
  primary queue action remains visible without scrolling.
- Uses the main checkout for both development and beta packaging; release checks
  exclude local rollback archives without traversing or including their contents.

The maintainer reported a successful smoke test after the local beta update;
see `VALIDATION.md` for verification scope and remaining coverage limits.
