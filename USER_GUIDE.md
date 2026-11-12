# Threadlamp user guide

## Begin with a small loop

Open Threadlamp on a ChatGPT conversation. Set **Message to send** and **Number
of messages**, then select **Start loop**. The extension waits for a finished
response before attempting the next message. Use a limit of 1 for your first test.
The Continue and Status buttons send those prompts once.

Typing a manual draft prevents an automatic send. Inspect the conversation if
the UI reports uncertain delivery; do not assume a message was delivered or retry
without checking. ChatGPT page changes can break completion detection or controls.

## Logic Mode

Starting Logic Mode sends instructions asking the assistant to end responses with
a control marker:

| Marker | Meaning |
| --- | --- |
| `[[LOGIC:CONTINUE]]` | Send the configured follow-up if eligible. |
| `[[LOGIC:USER_INPUT]]` | Wait for your response or a configured server event. |
| `[[LOGIC:WAIT:15m]]` | Wait, then request status; whole minutes 1–120 are supported. |
| `[[LOGIC:IDLE]]` | End this cycle and sleep until a heartbeat. |

The assistant supplies these markers; they are not proof that its work is correct
or that an external action is authorized. Review approvals and consequential work.
Missing or invalid markers can pause automation for inspection.

The follow-up limit includes automatic continuations and scheduled Status checks. Startup, shutdown and manual messages are additional.
Heartbeats begin new cycles with new counters. This is not a total token or cost cap.

**Pause** holds automation and can be resumed. **Stop logic** ends Logic Mode and
disables its schedule; when needed it waits for a free composer and sends a
shutdown instruction. It does not cancel an answer ChatGPT is already generating.
Stopping a sleeping chat does not send that shutdown message.

## Delivery timeout recovery

During an active Logic run, Threadlamp saves a temporary checkpoint for that tab
and conversation. A delivery-timeout notice triggers a 30-second wait followed
by at most one reload per run. It never clicks Retry or resends the failed prompt.

After reload, it allows up to 60 seconds for the conversation to load and verifies
the last user message by its message ID and a hash. It restores the message count
and settings, monitors an ongoing response, or processes a completed response's
Logic flag. The reload itself does not consume a follow-up.

Another error, a missing or changed message, or a page that does not recover leaves
Logic Mode visibly paused. Drafts and queued instructions also pause recovery so
they are not lost. Stop cancels reconnection without sending a shutdown prompt.
An unrelated page reload restores a recent checkpoint in a paused state for review.
Checkpoints expire after ten minutes without updates and are not a permanent backup.

## Prompt queue

Use **Show prompt** on the page or **Prompt queue** in the dashboard. A queued
instruction is appended once to the next eligible automatic turn. Typing alone
does not enqueue it. Replace or cancel the pending instruction before sending.

Each chat has one queue, up to 8,000 characters. Queueing does not override Pause,
approve an input request, or bypass the follow-up limit. Stop discards the queue;
refreshing a tab or reloading the extension loses in-tab drafts and queues.
After a send attempt with uncertain delivery, the queued text is not replayed
automatically.

## Dashboard

Open **Open agent dashboard** from the popup. The dashboard lists eligible chats
in this Chrome profile, with input requests and errors prioritized. Select a chat
to view status, pause/resume it, queue instructions, reply, or manage its schedule.
Chats in one project remain separate targets. Offline or changed chats may require
a refresh of dashboard status before controls can proceed.

Activity contains up to 300 recent local events. Dismissing an event does not answer
the underlying request. Clear history removes event history; it is not a command
to delete all saved agent metadata, schedules, or credentials.

## Heartbeats

Choose an interval or specific times/days, timezone, heartbeat prompt and cycle
limit. The current default timezone is **America/Chicago**; change it to your own.
When a saved chat reaches IDLE with no schedule, Logic Mode may create a 60-minute
heartbeat automatically. Explicitly paused, disabled or blocked schedules remain so.

Chrome and the chat tab must remain available. Alarms can run late and cannot wake
a sleeping computer. Busy cycles skip overlapping wakeups. Missing or ambiguous
tabs and uncertain dispatch require attention. Pause or disable schedules when
finished. A per-cycle follow-up limit does not cap the number of future cycles.

Errors and automatic message-limit stops remain in the on-page banner until you
select **Dismiss**. Dismissing a notice does not send a message or restart a run.

## Conversation rollover

For supported conversation-length notices, project rollover can continue in a
verified new chat in the same project. This depends on ChatGPT's current English
UI and available navigation. Threadlamp prefers an observed project navigation
link that keeps the stable project ID visible. A project name by itself cannot
verify a destination. If ChatGPT opens a page that exposes only a name, Threadlamp
stops with a notice instead of guessing. Existing conversations are never used
as automatic handoff destinations. The continuation includes the source project
ID and chat link; the agent must request missing context if it cannot access it.

If the landing page restores a complete Threadlamp handoff draft, Threadlamp
clears it and writes a fresh continuation for the verified source conversation.
Edited handoff text and unrelated drafts are preserved. The receipt, destination,
and editor are checked again before clearing and sending. If the destination
does not become ready, the stopped notice identifies the check that failed.
Prior conversation turns retained in hidden page sections do not block a new
project landing page. A saved conversation containing history still cannot be
used as a handoff destination, even when that history is hidden.

A successful handoff means the continuation message was observed in the new chat;
it does not verify that the model recovered all prior context. Review the first
response. Threadlamp does not extend the model context or reset an
account usage allowance. Quota errors must not be treated as permission to bypass
limits. Check the live chat if a service or quota notice appears.

## Optional Home Assistant notifications

Use **Open settings in tab**. Enter your Home Assistant origin, mobile notification
action and access token locally. A dedicated non-administrator account is preferred.
Chrome asks for access to the configured site. Notifications may include a brief
input request, chat title/link, status or error detail. Review the privacy notice.

**Test notification** sends a real notification. Phone Approve/Reply actions can
submit a message to the matched waiting chat. Review what you approve.
The browser must remain connected. **Forget settings** removes saved Home Assistant
configuration; revoke the token separately in Home Assistant as well.
Use HTTPS for a Home Assistant connection beyond a trusted local environment.

## Optional project server

See [SERVER_CONNECTION.md](SERVER_CONNECTION.md). Setup sends a one-time pairing
token through the selected ChatGPT conversation. That copy remains in the chat;
consuming the token on the server does not erase it from ChatGPT history.
Only the paired loopback endpoint is supported. The permanent backend credential
must stay out of chat. Events carry submission identifiers; the agent retrieves
the underlying submission using its own configured access.

## Update, backups and removal

Keep an unpacked extension at the same path and reload its existing entry to
preserve its identity. Plan reloads after active work finishes. Refresh designated
ChatGPT tabs when ready to load updated page scripts. Do not run old and beta
copies against the same conversations at once.

The encrypted settings export includes Home Assistant credentials, loop defaults,
rollover preference and sound preference. It does **not** back up server bindings,
server credentials/inboxes, heartbeat schedules, dashboard history, running state
or queued prompts. Keep its passphrase separately; it cannot be recovered.

Uninstalling deletes extension-managed local storage. It does not erase ChatGPT
messages, downloaded backups, phone notifications or records on connected services.
Use those services' deletion and revocation controls separately.
