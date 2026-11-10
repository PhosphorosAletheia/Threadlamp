# Threadlamp

**Keep ongoing ChatGPT work in view.**

A Chrome extension from [Phosphoros Research](https://phosphoros-research.pages.dev/).
Threadlamp brings follow-up controls, a prompt queue, scheduled check-ins, and a
dashboard for your open ChatGPT conversations into one local workspace.

**Version 1.9.6 beta 1.** This is an independent project, not an OpenAI product.
It uses your existing ChatGPT session and normal plan allowance. It does not
provide extra quota or promise that an AI agent will complete a task correctly.

## What it does

- Run a bounded sequence of follow-up messages after responses finish.
- Use Logic Mode to continue, wait, sleep, or ask for your input.
- Queue an instruction for the next eligible automatic turn.
- See conversation status and control each chat from the agent dashboard.
- Schedule per-conversation heartbeats while Chrome and the chat remain available.
- Optionally connect your own Home Assistant instance or a project-local server.

Logic Mode can automatically create a 60-minute heartbeat when a saved chat first
reaches IDLE without an existing schedule. Review that schedule before leaving
a run unattended. Follow-up limits apply per cycle, not as a total token budget.

## Install the GitHub beta

1. Download the extension ZIP from [Threadlamp releases](https://github.com/PhosphorosAletheia/Threadlamp/releases) and extract it into a
   permanent directory. Keep that directory for future updates.
2. Open `chrome://extensions`, enable **Developer mode**, then **Load unpacked**.
3. Select the extracted directory containing `manifest.json`.
4. Open a designated ChatGPT test conversation and pin Threadlamp if desired.
5. Start with a harmless task and a follow-up limit of **1**. Review each result.

Chrome 116 or newer is required by the manifest. No API key or companion server
is required for the dashboard and ordinary follow-up controls. Optional project
server integration needs a compatible server you control; none is bundled here.

If you already have an older development copy, do not leave both copies
automating the same chats. Loading this beta separately creates separate extension
storage and may change the extension ID. See the [user guide](USER_GUIDE.md).

## Privacy and permissions

Read the [privacy notice](PRIVACY.md) before installation. Threadlamp reads chat
content locally to identify completion, control markers, and input requests.
Short request summaries, titles, URLs, status and schedule data may be stored
locally. Optional integrations send the documented data to services you configure.
The extension includes no publisher analytics or telemetry endpoint.

## Documentation and development

- [User guide](USER_GUIDE.md)
- [Local server protocol](SERVER_CONNECTION.md)
- [Optional agent instruction template](AGENT_EXTENSION_SETUP_PROMPT.md)
- [Beta limitations and release checks](RELEASE_CHECKLIST.md)
- [Security reporting](SECURITY.md) · [Contributing](CONTRIBUTING.md)

Run the offline test suite with Node.js (tested with the version recorded in
`VALIDATION.md`):

```sh
node --test tests/*.test.js
python3 scripts/check_release.py
python3 scripts/package_release.py
```

The packager uses an explicit file inventory and writes two deterministic ZIPs
and checksums under `dist/`: the installable extension and the public source.
Neither archive contains Git history, development backups, or local settings.

## License and publisher identity

Source code and documentation are licensed under the [Mozilla Public License
2.0](LICENSE), except publisher/app identity assets described in [BRANDING.md](BRANDING.md).
Copyright (c) 2026 Phosphoros Research and contributors.

MPL permits commercial use and redistribution. When distributing modifications
to covered files, make their source available under MPL as required by the
license. New independent files in a larger work can have other licenses.
The names and marks do not grant permission to imply publisher endorsement.

ChatGPT and OpenAI are names of their respective owner. Threadlamp is not
affiliated with, endorsed by, or sponsored by OpenAI.
