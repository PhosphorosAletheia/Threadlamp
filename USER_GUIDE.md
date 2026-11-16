# Threadlamp user guide

## Begin with a small loop

Open Threadlamp on a ChatGPT conversation. Set **Message to send** and **Number
of messages**, then select **Start loop**. The extension waits for a finished
response before attempting the next message. Use a limit of 1 for your first test.
The Continue and Status buttons send those prompts once.

Typing a manual draft prevents an ordinary automatic send. A verified automatic
new-chat handoff clears the destination message box as described below. Inspect
the conversation if the UI reports uncertain delivery; do not assume a message was delivered or retry
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

## Connection error recovery

During an active Logic run, Threadlamp saves a temporary checkpoint for that tab
and conversation. A **Message delivery timed out. Please try again.** or
**Error in message stream** alert with a Retry button triggers a 30-second wait
followed by at most one reload per run. Threadlamp never clicks Retry or resends
the interrupted prompt. It also watches for these errors when a partial response
has left Logic Mode waiting for its final flag. Text quoted inside a chat response
does not trigger recovery.

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

Use **Show prompt** on the page or **Prompt queue** in the dashboard. Type a
message and click **Add to queue**. Each click adds a separate entry without
replacing earlier messages. The list shows pending messages in order; use
**Remove** beside an entry or **Clear queue** to remove them all.

One queued message is appended to each eligible automatic turn. You can keep
adding messages while an earlier one is being prepared, but that entry cannot
be removed once preparation begins. Each chat supports up to 100 messages,
8,000 characters per message, and 80,000 characters across the queue.

Queueing does not override Pause, approve an input request, or bypass the
follow-up limit. Remaining entries carry into a verified new-chat handoff.
Added messages are saved in this Chrome profile and restored when the same saved
conversation is reopened, including after a browser restart. Stop preserves them;
use **Remove** or **Clear queue** to discard them. Text still being typed in an
editor is not a saved queue entry. Queue restoration does not itself start a run.
The extension saves removal of the next entry before clicking Send. If interrupted
at that point, inspect the draft and chat: that entry is not automatically replayed,
even when delivery is uncertain. Later entries remain queued. A storage or
competing-tab conflict stops sending; reload the correct chat to review its saved
queue before resuming. Keep one active automation tab per conversation.

During a verified handoff, the queue moves to the destination atomically. Until a
new conversation has a saved URL, its queue is bound to that tab. Reopen the saved
destination to restore remaining entries. If the browser closes before a destination
URL exists, inspect the interrupted handoff rather than starting it again; its
stored queue is retained but is not automatically assigned to another unsaved tab.
Unsent queues are never silently evicted to make space. The profile-wide queue
store has a two-million-character bound; remove unused queued messages if it fills.

## Dashboard

Open **Open agent dashboard** from the popup. The dashboard lists eligible chats
in this Chrome profile, with input requests and errors prioritized. Select a chat
to view status, pause/resume it, queue instructions, reply, or manage its schedule.
For an idle agent, use **Run heartbeat now** beside its status to start its saved
heartbeat immediately. The schedule must be enabled; resolve any pause, error,
or unsent chat draft first. The same action is available in the Heartbeat tab.

Check **Hide unavailable agents** above the agent list to show only connected
agents. Your choice is remembered when you reopen the dashboard. Uncheck it to
show unavailable agents again; hiding an agent does not stop or remove it.

Chats in one project remain separate targets. Offline or changed chats may require
a refresh of dashboard status before controls can proceed.

Use **Message all agents** above the agent list to open a shared message box.
**Queue for all agents** adds a separate message at the end of each connected
agent's queue, including agents hidden by search or filters.
The recipient list is fixed when you open the popup; newly connected chats are not
added while you type. This queues instructions without starting or resuming agents.

The popup lists each outcome. Offline agents are excluded; unavailable queues,
changed conversations, duplicate tabs for the same conversation, and queues that
would exceed their message or character limits are skipped or rejected. Inspect any unconfirmed
queue before retrying that agent individually. Reopening the popup shows the last
results; choose **New message** to compose another broadcast. Dashboard edits that
have not been queued remain in their individual editors.

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

An automatic handoff controls the new destination message box. After verifying
the handoff record and destination project, Threadlamp clears any text restored
there, including another agent's handoff or queued instructions. It builds a fresh
continuation from the original conversation and that agent's own queue, verifies
High thinking, and checks the complete prompt again before sending. Do not enter
text in the new destination while a handoff is underway. A change during
verification, an expired handoff, or an unverified project still stops the send.
If the destination does not become ready, the stopped notice identifies the check
that failed.
Prior conversation turns retained in hidden page sections do not block a new
project landing page. A saved conversation containing history still cannot be
used as a handoff destination, even when that history is hidden.

An enabled heartbeat schedule stays attached to the source conversation while the
verified continuation is prepared and sent. It moves to the destination only after
the continuation is observed there. Ordinary navigation does not authorize a send.

If ChatGPT assigns the new conversation URL late, Logic Mode checks the delivered
message ID and text before adopting it. A delayed URL alone does not stop the run;
missing or mismatched message identity still requires inspection. Paragraph and
line-break formatting is preserved when comparing the delivered continuation.

If an older version stopped after the continuation already ran, save any queued
or unsent text before updating the extension. Reload the affected saved chat,
then use **Resume** in the extension popup to monitor its existing response
without sending the startup instructions again. Inspect the destination project
and response first; do not retry a handoff that was already delivered.

A successful handoff means the continuation message was observed in the new chat;
it does not verify that the model recovered all prior context. Review the first
response. Threadlamp does not extend the model context or reset an
account usage allowance. Quota errors must not be treated as permission to bypass
limits. Check the live chat if a service or quota notice appears.

## Dashboard summaries and draft rewriting

Logic Mode now writes its own summary, up to **600 characters**, immediately
before the final control marker:

```text
[[LOGIC:SUMMARY: Reviewed the results; two checks still need attention.]]
[[LOGIC:CONTINUE]]
```

Threadlamp reads that line locally. It never sends completed assistant responses
to OpenRouter. SUMMARY does not change the control marker or grant permission to
continue. For an input request, the order is BRIEF, SUMMARY, then USER_INPUT.
Missing, duplicate or overlong summaries leave the previous valid summary visible
with an explanation; they do not stop an otherwise valid Logic loop.

New **Start Logic Mode** prompts and new-chat handoffs include these instructions.
Existing chats need the updated instructions once: when safe, use **Start Logic
Mode**, which sends the new startup prompt. **Resume after reload** only monitors
the existing conversation and does not send updated instructions. Summaries are
always local and do not require a key or an enabled rewrite setting. Up to 100
conversation summary records are retained. **Clear saved summaries** in Settings
removes them; clearing dashboard activity does not.

Every dashboard message editor has **Rewrite for agent**, including replies,
queued messages, Message all agents, automatic follow-ups and heartbeat prompts.
Click it to send only that editor's draft to OpenRouter's `openrouter/free` model
router. The result replaces the draft without sending or queueing it. Review it,
or use **Undo rewrite** to restore the original. Editing the draft, changing agents
or submitting while a request runs prevents the late result from replacing text.
Failures leave the original draft intact.

In **Settings → Draft rewriting & local summaries**, enter your OpenRouter key
locally, enable rewriting, save and allow `https://openrouter.ai` access. Existing
saved keys and the old enabled setting are reused for rewriting. No key belongs
in a chat or source file. Disabling rewriting or forgetting the key does not
disable local summaries. Provider data policies apply to drafts you rewrite.

There is no paid fallback. Inputs and returned drafts must fit the editor's
4,000- or 8,000-character limit; incomplete or oversized replies are rejected
without silently truncating your instructions. Requests have a 4,096-token output
budget, a 25-second timeout and a maximum of two concurrent rewrites. Rate limits
share a persistent cooldown: Retry-After when supplied, otherwise one minute with
increasing backoff up to one hour. Requests are never automatically retried.
The key, queues and summaries are excluded from settings backups. Rewrite input
and output are not saved by Threadlamp's rewrite service or diagnostic logs.

Agent bullets show **green** while running (including scheduled sleep or waiting
on an external operation), **yellow** when input is needed, **orange** for errors,
**red** when stopped, and **blue** when paused. Unavailable agents remain gray.
The accompanying status text distinguishes sleeping from actively working.

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

If a new chat already received its continuation but stopped with **Untrusted
rollover request**, update Threadlamp, inspect the destination and its latest
response, then use **Resume** in the popup or **Resume after reload** in the
dashboard. This follows the existing response without sending the startup again.
Review any heartbeat schedule or server connection separately: a failed handoff
may have stopped before those connections transferred to the new chat. Version
1.17.1 retries explicitly rejected confirmations automatically while preserving
chat-ownership checks. Missing replies and uncertain results still stop for review.

## Update, backups and removal

Keep an unpacked extension at the same path and reload its existing entry to
preserve its identity. From version 1.17.0 onward, reloading or updating the
extension automatically reattaches controls to loaded ChatGPT tabs without
refreshing those pages. The conversation can keep generating, and existing
drafts and saved queues remain in place.

Reattached tabs show **Threadlamp · Paused**. Inspect the latest response and any
draft, check the follow-up text, turn limit and project-handoff setting, then use
**Resume** in the popup or **Resume after reload** in the dashboard when ready. This does not resend
the startup prompt. Interrupted sends and handoffs are never replayed by the
reattachment process. Enabled heartbeat schedules are paused too; resume a
schedule separately after reviewing the conversation. Existing manual pauses,
WAIT timers and run counters are not automatically resumed or reconstructed.

**First upgrade from 1.16.4 or earlier:** refresh each designated chat once when
safe to install the new shutdown mechanism. Later extension reloads can use
reattachment. Loading tabs must finish loading; discarded tabs must be opened.
The popup can retry attachment without refreshing the page. If a tab cannot be
attached safely, it explains that a manual refresh is needed. Do not run old and
beta copies of the extension together.

The encrypted settings export includes Home Assistant credentials, loop defaults,
rollover preference and sound preference. It does **not** back up server bindings,
server credentials/inboxes, heartbeat schedules, dashboard history, running state
or queued prompts. Keep its passphrase separately; it cannot be recovered.

Uninstalling deletes extension-managed local storage. It does not erase ChatGPT
messages, downloaded backups, phone notifications or records on connected services.
Use those services' deletion and revocation controls separately.

## Dashboard on your LAN

Use the optional [LAN dashboard helper](LAN_DASHBOARD.md) to queue messages,
broadcast, control Logic Mode, and manage heartbeats from another device. Setup
requires the source package and a local Node.js helper. LAN access is off until
you pair it in extension settings.

## Diagnostics and error reports

Local diagnostics are on by default. Threadlamp records its version, content-script
version, event times, anonymized project/chat references, tab identifiers, state
changes, and the checks around automatic sends and handoffs. Error snapshots keep
recent events from that tab, including draft/message lengths, structural checks,
High-thinking checks, identity-confirmation results, page reload/discard indicators,
and extension code locations where an error was reported. Handoff confirmation
retries, handoff trust failures, reconnection trust failures and missing final
Logic flags have separate diagnostic categories. Recovery records distinguish
message-stream errors from delivery timeouts. Rewrite request
lengths, elapsed times, cooldown and error categories are included too. No rewrite
text is logged.
Message text, queued instructions, replies, titles, full URLs, and credentials are
not included. References let us correlate events without exposing project or chat
IDs; they change when diagnostics are cleared.

Open **Dashboard → Settings → Diagnostics** to download a JSON report, turn
recording off, or clear saved diagnostics. Recording keeps at most 400 recent
events and 20 error snapshots, with up to 40 events in each snapshot. Entries older
than seven days are pruned when the recorder is accessed. Repeated events are
limited to keep logging lightweight. Turning recording off retains existing
reports until you clear them. Clearing diagnostics does not clear your agent
history, queues, schedules, or settings.

The paired LAN helper saves a private host file automatically every 30 seconds
while connected: `diagnostics/latest.json` inside its setup directory. With the
default setup, that is `~/.config/threadlamp-lan/diagnostics/latest.json`. Restart
the updated helper once to enable this feature, and after updates that add new
diagnostic fields. It overwrites that one file rather
than accumulating logs. After disconnecting, the file remains the last available
snapshot; its `generatedAt` time shows its age. A clear operation reaches the file
on the next successful sync; existing downloads are never deleted automatically.

When reporting an error, leave the affected chat unchanged and identify the agent.
If the local helper is running, the host report may already have the evidence we
need. Otherwise, download the report and attach it. Recording cannot reconstruct
an earlier failure from before this version was loaded, and an invalidated
extension context cannot send new events; the reattached controller resumes
reporting. Older controllers need one safe tab refresh. Earlier
recorded events remain available. Reports help diagnose a failure; they do not
prove that a remote task completed or that a message was delivered.
