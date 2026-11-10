# Threadlamp privacy notice

Publisher: [Phosphoros Research](https://phosphoros-research.pages.dev/).
Applies to Threadlamp 1.9.7 beta 1. Prepared November 9, 2026.

## Data handled

Threadlamp runs inside your Chrome profile. It reads the visible ChatGPT page,
including conversation content, composer state, titles, URLs and control markers,
to decide whether a requested follow-up can be sent and to display status.
There is no extension-operated publisher telemetry, advertising or analytics server.

| Data | Use and location |
| --- | --- |
| Loop prompts, limits and preferences | Saved in local extension storage. |
| Chat URLs/titles, project labels, status and short input-request summaries | Used in the dashboard; bounded agent/event records are stored locally. |
| Scheduled prompts, times, timezone and dispatch state | Stored locally for heartbeats across background-worker restarts. |
| Pending prompt queues and drafts | Held in the tab; a pending rollover may temporarily carry queue data in extension session storage. |
| Home Assistant address, notification action and access token | Stored locally only if configured; used to contact that service. |
| Project server bindings, credentials, setup state and event identifiers | Stored locally if configured; used for pairing and routed event delivery. |
| Pending phone actions and rollover records | Held in extension session storage, with some notification-routing metadata stored locally. |

The dashboard does not archive complete conversation transcripts. Short excerpts
from assistant input requests and error/status details can nevertheless contain
sensitive information. Recent events are capped at 300 and agent records at 100;
these bounds are counts, not automatic time-based deletion periods.

## When data leaves the browser

- **ChatGPT:** requested prompts, follow-ups, queued instructions, replies and
  setup messages are submitted through your signed-in ChatGPT page. OpenAI's
  applicable terms and privacy practices govern its processing.
- **Home Assistant, if enabled:** your configured instance receives authentication
  and notification requests containing chat links, titles, brief requests, status
  or errors. Its mobile notification delivery may involve push service providers.
  Approve/Reply actions return through Home Assistant and can be sent to ChatGPT.
- **Project server, if enabled:** authentication, project/setup identifiers and
  event acknowledgments are exchanged with your configured loopback server.
  A one-time pairing token is intentionally included in its ChatGPT setup prompt;
  it remains in chat history even after the server consumes it. The permanent
  credential is stored locally and is not intentionally included in chat.
- **Links you choose to open:** the lab website and other documentation sites
  receive ordinary browser requests. The extension does not fetch remote fonts,
  logos or executable code to render its interface.

Phosphoros Research does not receive your chat content through a built-in telemetry
channel. Information you voluntarily submit in an issue or support report is
separate; public GitHub issues are visible to everyone.

## Storage and security

Chrome extension storage is not encrypted by this extension. Tokens are restricted
to trusted extension contexts, but anyone with sufficient access to your browser
profile or operating system may be able to read them. Protect your device.

An optional downloaded settings backup is encrypted locally with AES-256-GCM and
PBKDF2-SHA-256. It includes the Home Assistant access token. Your passphrase is not
saved or sent; loss of it makes that backup unrecoverable. The backup omits several
other data categories; see the user guide.

## Permissions

| Permission | Reason |
| --- | --- |
| `activeTab` | Interact with the active ChatGPT tab from the popup. |
| `storage` | Save preferences, schedules, integration records and bounded history. |
| `offscreen` | Play locally generated notification sounds. |
| `scripting` | Reattach bundled page scripts to an eligible active chat when needed. |
| `alarms` | Schedule heartbeat wakeups. |
| ChatGPT host access | Read page state and submit the requested chat controls. |
| Optional HTTP/HTTPS hosts | Request user-selected Home Assistant site access or localhost access for project connections. The declaration permits configurable hosts; access is requested at setup. |

## Control and deletion

Pause/stop automation and disable schedules to prevent future automatic work.
Clear dashboard event history through its UI. Use **Forget settings** for Home
Assistant and remove project connections when no longer needed. Revoke credentials
at their originating services. Uninstall removes extension-managed local storage;
delete downloaded backups and service-side messages/records separately.

For a privacy question, use the repository's issue tracker with a nonsensitive
description. For a vulnerability, follow [SECURITY.md](SECURITY.md). Never publish
credentials, chat URLs, transcripts, backup files or diagnostic dumps in an issue.
