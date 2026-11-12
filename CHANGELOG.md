# Changelog

## 1.10.0 beta 1

- Add optional OpenRouter last-output summaries to agent cards and the dashboard.
  Each request contains one completed assistant response, through its ending
  Logic tag, rather than the conversation or multiple response cycles.
- Use `openrouter/free` with local API-key settings and optional host access.
- Keep summary requests independent of Logic Mode controls; expose failures,
  deduplicate repeated completions, and reject late updates for older outputs.
- Retain bounded summary records locally, with separate disable, key removal,
  and summary deletion controls. Raw assistant output is not persisted.

## 1.9.13 beta 1

- Allow a verified project-chat continuation to start while its heartbeat schedule
  still belongs to the source conversation. Recheck ownership before writing and sending.
- Move the schedule only after the continuation is confirmed in the new chat;
  ordinary navigation and cancelled handoffs still stop automatic sending.

## 1.9.12 beta 1

- Ignore prior conversation turns retained inside hidden page subtrees when
  reading the active chat or preparing a handoff on a project landing page.
- Continue to reject saved handoff destinations containing hidden history.
- Keep offscreen turns and accessible response labels eligible for message
  detection; a zero-sized element alone does not mean the conversation is empty.

## 1.9.11 beta 1

- Replace a complete restored Threadlamp handoff draft with a fresh continuation
  for the verified source project and conversation. Preserve edited or unrelated drafts.
- Recheck the handoff receipt, destination, and draft before clearing the editor.
- Verify the current browser document when a sender URL differs after navigation,
  keeping alerts and related controls bound to the correct tab and main frame.
- Report the specific readiness check that blocks a handoff instead of always
  attributing a timeout to the project ID.

## 1.9.10 beta 1

- Recover from a delivery timeout with one delayed reload of the same chat,
  without resending the failed prompt or clicking Retry.
- Restore verified Logic Mode settings and counts, observe an active response,
  and process a completed response using its normal Logic flag.
- Recognize timeout pages with no composer or chat turns. Pause visibly if
  reconnection fails, another error appears, or the chat cannot be verified.
- Preserve drafts and queued instructions by pausing instead of reloading when
  either is present.

## 1.9.9 beta 1

- Fix dashboard project names being replaced by the accessibility label
  "Skip to content". Clear previously saved instances of that label and preserve
  valid project names when older chat tabs report it.

## 1.9.8 beta 1

- Keep errors and message-limit stops visible until dismissed.
- Bind handoffs to the source tab or its newly created child, using stable project
  IDs. Existing conversations cannot receive an automatic handoff.
- Prevent duplicate handoff claims and confirm the continuation before moving
  heartbeat schedules or server connections.
- Stop automatic sends and quick prompts when the chat or draft changes.
- Preserve heartbeat schedule identity when a project is renamed.
- Keep phone approvals bound to their original tab and conversation; protect
  simultaneous notification updates and reject redirected notification requests.

## 1.9.7 beta 1

- Fix queued follow-ups stopping before Send when the ChatGPT editor adds an
  empty decorative icon to the draft. Full message text must still match, and
  manual edits, attachments, and unsupported content continue to block sending.

## 1.9.6 beta 1

First public beta of Threadlamp by Phosphoros Research.

- Follow-up loops with message limits and Pause/Stop controls.
- Logic Mode with continue, wait, input-request, and idle states.
- A prompt queue for adding instructions to the next automatic turn.
- A dashboard for conversation status, replies, and schedules.
- Per-conversation heartbeats and project conversation rollover.
- Optional Home Assistant notifications and local server event delivery.
- Encrypted export and import of supported settings.
- Compact dashboard layout with an accessible queue action at intermediate heights.

See the [user guide](USER_GUIDE.md) for controls, scheduling behavior, and backup
coverage, and the [README](README.md#beta-limitations) for beta limitations.
