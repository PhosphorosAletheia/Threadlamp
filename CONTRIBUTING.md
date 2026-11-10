# Contributing

Please discuss significant behavior changes in an issue first. Use invented
project names, chat IDs, service URLs and credentials in tests and bug reports.
Never commit local configurations, browser data, exported settings or transcripts.

Source and documentation contributions are accepted under MPL-2.0. Submit only
material you have the right to license. Preserve existing notices and identify
third-party code and its license. Do not copy proprietary snippets into this repo.

Run `node --test tests/*.test.js` and `python3 scripts/check_release.py` before
submitting. For behavior changes, add meaningful tests for stale state, drafts,
navigation and uncertain sends. Keep live-service tests separate and explicit.

The dashboard fixture uses invented agents:

```sh
node tests/dashboard-ui.fixture.js /absolute/path/to/temporary-preview
```

It writes a standalone HTML preview and exercises mocked UI actions. It does not
prove authenticated ChatGPT integration. Keep screenshots and test output out of
the source tree unless deliberately reviewed for publication.

## One development checkout

Develop in the checkout tracking this repository's `main` branch. Build the beta
from that same checkout with `python3 scripts/package_release.py`; `dist/` is
generated output, not a separate development tree. Use ordinary feature branches
when needed rather than maintaining an independent beta copy.

Local rollback archives belong in the ignored `rollback-artifacts/` directory.
The release checker skips local archives and tool directories, while the explicit
release inventory still rejects entries inside them. Never add private archives
with `git add -f`, merge private development history into this repository, or push
an archived repository's branches or tags here.

For an unpacked installation, keep the checkout at its existing path and reload
the existing Chrome extension entry when active work is ready. Updating source
files does not establish that Chrome has loaded the new version.
