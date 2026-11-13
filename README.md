# Threadlamp

**Keep ongoing ChatGPT work in view.**

A Chrome extension from [Phosphoros Research](https://phosphoros-research.pages.dev/).
Threadlamp brings follow-up controls, a prompt queue, scheduled check-ins, and a
dashboard for your open ChatGPT conversations into one local workspace.

**Version 1.14.1 beta 1.** Threadlamp uses your existing ChatGPT session and plan
allowance. No OpenAI API key is required. It is an independent project and is
not affiliated with, endorsed by, or sponsored by OpenAI.

## Features

- Send a limited sequence of follow-up messages after responses finish.
- Use Logic Mode to continue, wait, sleep, or ask for your input.
- Queue multiple messages in order, one per automatic turn.
- View conversation status and control each chat from the dashboard.
- Optionally use the full dashboard across your LAN with an authenticated HTTPS helper.
  See [LAN dashboard setup](LAN_DASHBOARD.md).
- Optionally summarize each finished Logic Mode response with OpenRouter’s free router.
- Schedule per-conversation check-ins, called heartbeats.
- Optionally connect Home Assistant notifications or a local project server.

## Install

Requires **Chrome 116 or newer**.

1. Download the extension ZIP from [Threadlamp releases](https://github.com/PhosphorosAletheia/Threadlamp/releases)
   and extract it into a permanent directory.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked**, then choose the directory containing `manifest.json`.
4. Open a ChatGPT conversation and select Threadlamp from Chrome's extensions menu.
5. Enter a follow-up message, set the limit to **1**, and select **Start loop**.

For updates, replace the files in the same directory and reload the existing
extension entry after active work finishes. Refresh your ChatGPT tabs to load the
updated page scripts. Avoid running two copies against the same conversations.

## Beta limitations

Threadlamp depends on ChatGPT's web interface and English control labels. Page
changes can affect completion detection, sending, and conversation rollover.
Review the conversation if delivery is uncertain.

Logic Mode can create an hourly heartbeat when a saved chat first reaches IDLE
without a schedule. Review schedules and set your timezone; the default is
America/Chicago. Chrome and the chat tab must remain available, and computer
sleep can delay scheduled work.

Follow-up limits apply per cycle. Threadlamp has no total token budget or quota
meter and does not increase your ChatGPT allowance. Review important results and
pause automation when ChatGPT reports a service or usage limit.

## Privacy

Threadlamp processes chat content locally to detect responses and input requests.
Settings, schedules, chat titles/URLs, and short status summaries are stored in
your Chrome profile. There is no publisher analytics or telemetry service.
Optional integrations contact services you configure. Read the
[privacy notice](PRIVACY.md) for data flows, permissions, and deletion controls.

## Documentation

- [User guide](USER_GUIDE.md)
- [Logic Mode protocol](docs/LOGIC_MODE_PROTOCOL.md)
- [Local server integration](SERVER_CONNECTION.md)
- [Changelog](CHANGELOG.md)
- [Security reporting](SECURITY.md)
- [Contributing and building](CONTRIBUTING.md)

## License

Source code and documentation are licensed under the [Mozilla Public License
2.0](LICENSE), except the identity assets described in [BRANDING.md](BRANDING.md).
Copyright (c) 2026 Phosphoros Research and contributors.

ChatGPT and OpenAI are names of their respective owner.
