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
