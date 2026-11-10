# Contributing

Please discuss significant behavior changes in an issue first. For a bug report,
include the extension and browser versions, steps to reproduce, expected behavior,
and actual behavior. Use invented project names, chat IDs, service URLs, and
credentials. Keep browser data, exported settings, and transcripts out of reports.
Report vulnerabilities through the [security reporting process](SECURITY.md).

Source and documentation contributions are accepted under MPL-2.0. Submit only
material you have the right to license. Preserve existing notices and identify
third-party code and its license.

## Development

Clone the repository and create a branch for your changes. Load the checkout as
an unpacked extension through `chrome://extensions`. After editing runtime files,
reload the extension and refresh the ChatGPT tab when active work has finished.

Run the offline tests with Node.js 18 or newer and the release checks with Python 3:

```sh
node --test tests/*.test.js
python3 scripts/check_release.py
```

For behavior changes, add tests covering relevant drafts, navigation, stale state,
and uncertain sends. The tests simulate browser and service APIs. Changes to chat
interaction also need a manual check in Chrome with a disposable conversation.

To preview the dashboard with sample conversations:

```sh
node tests/dashboard-ui.fixture.js /absolute/path/to/temporary-preview
```

The fixture writes standalone HTML and exercises mocked UI actions.

## Packaging

```sh
python3 scripts/package_release.py
```

The packager uses `release-files.json` to build deterministic extension and source
ZIPs, plus `SHA256SUMS`, in `dist/`. Update the inventory when adding or removing
files. Generated archives and local configuration do not belong in commits.

Before a release, check installation, a bounded follow-up, queue delivery,
Pause/Stop, heartbeat scheduling, input requests, and conversation rollover.
Test affected optional integrations with disposable data. Record the browser
version and results, scan the source for secrets, and inspect both archives.
