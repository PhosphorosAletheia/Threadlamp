# Local server connection — protocol 1

Threadlamp supports opt-in project server connections. This document specifies
the existing protocol; it does not include a companion server implementation.

## Set up

1. Open the saved ChatGPT conversation that should receive a project's events.
   Finish its current response and clear any draft. Setup will not interrupt
   active work, a manual pause, or a request for human input.
2. Open the extension popup, expand **Local server connection for this project**,
   and select **Set up connection**. Chrome may request permission for loopback
   hosts.
3. The extension sends a generated prompt. The agent adds the protocol below to
   its own server and replies with a fresh `SERVER_READY` block. There is no
   manual address-copy step.
4. The extension verifies the server, performs a transport test, and sends a
   confirmation prompt. The agent must finish confirmation with `[[LOGIC:IDLE]]`.
5. If the chat was already sleeping, its existing heartbeat resumes. Otherwise
   select Start logic / Start next cycle to enable event processing.

Setup/recovery prompts distinguish connection metadata from secrets and request
the complete single-line `SERVER_READY` marker inside a fenced plain-text code
block. Setup/project IDs and the loopback endpoint belong in that reply; pairing
tokens and permanent credentials do not. Bare opening tags cannot advance setup.
Fenced replies retain the same strict attempt, project, endpoint, and transport
checks. This formatting change is a workaround to test, not proof of why a
previous reply was incomplete.

Server instructions also require HTTP/1.1 upgrade responses and browser-compatible
compression negotiation. An unsupported `permessage-deflate` offer is declined by
omitting the extension response header, without rejecting an otherwise valid
request. Origin, endpoint, and authentication checks remain required.

Setup waits for a fresh, stable reply with a `SERVER_READY` block or final Logic
directive; pauses between thinking/tool steps do not end the wait. Confirmation
also waits for a final Logic directive and requires `[[LOGIC:IDLE]]`. There is no
fixed 15-minute limit on the agent's work. A 15-minute lease renews while the same
chat page and setup attempt remain active; an abandoned attempt expires instead.
There are still at most five setup follow-ups, and server transport verification
remains bounded. Setup replies do not dispatch form events or ordinary Logic
Mode follow-ups. Human-input replies stop setup for inspection, even when they
also contain a server-ready block. Retry setup explicitly after resolving them.
Stop or Disable cancels setup without clearing manual text. The popup retains
the specific setup failure reason.

### Recover an interrupted setup

Let the current agent response finish, then use **Recover connection** in the
assigned chat. This is a separate button available even when the extension has
no saved setup record. In that case, the agent locates its existing integration
in the current project's chat history, framework, and server configuration; the
extension creates a new binding and pairing authorization for that service.
It cannot reconstruct lost inbox or processed-event history, so the server and
agent must retain their submission IDs and deduplicate completed work.

The old setup message need not be the latest message or still present in the DOM.
Recovery uses the saved project binding and server configuration, then sends a
fresh tagged exchange. A page/browser restart can change the tab ID and page
instance; explicit recovery verifies the restored assigned chat and updates its
owner. A stale saved setup phase does not impose a 15-minute lockout: the worker
checks whether the original attempt is actually running. A live attempt is
rejected without sending another prompt. Old assistant flags in an inactive chat
do not block explicit recovery; current Pause, drafts, active cycles, and active
human-input holds retain their protections.

An existing attempt automatically uses recovery, even if an older
popup still sends the original setup action. The shorter recovery prompt asks
the agent to inspect and reuse its existing service, port, saved data, outbox,
and completed work, repairing only missing integration pieces. It must request
human input if the original service is missing or ambiguous, rather than create
a replacement.

Recovery retains the saved endpoint, credential, and pending/processed event
IDs. When a credential exists, the extension authenticates with it. When pairing
was incomplete, it supplies a fresh pairing token for the same integration.
Each recovery has a fresh setup ID to distinguish its reply from older replies;
that ID does not mean a new server. A reply with a different saved endpoint is
rejected. When no endpoint was saved, the agent must recover it from its existing
configuration and earlier work; the extension cannot independently prove an
unsaved address was the original one.

The extension never automatically replays a failed setup prompt. A busy chat's
explicit refusal preserves the previous saved state, and uncertain business
event deliveries must be resolved before recovery.

Each outgoing setup/recovery prompt, follow-up, and confirmation has a fresh
`[[SERVER_SETUP_REQUEST:<random UUID>]]` tag. Before Send, the complete composer
draft must match the intended message. After Send, the extension requires a fresh
user turn containing exactly that request tag, then a fresh assistant reply
after it. It does not compare the entire rendered prompt, which can contain UI
labels or be split into content blocks. A missing, stale, or duplicate request
tag cannot authorize the next step. This identifies a sent turn; it never grants
permission to clear an arbitrary draft. The agent must not echo the request tag;
its reply uses `SERVER_READY` or the requested Logic Mode final flag.

The server must run at `localhost` or `127.0.0.1` as reachable from this Chrome
computer. The agent must reuse its existing port, or choose and persist one
available port from 1024 through 65535. It must not silently change ports or stop
another process to acquire its preferred port.

## Assignment and persistence

Bindings use the stable `g-p-<32 hex digits>` project identifier, with the name
used only as a label. They also store the exact receiving conversation URL.
Different projects can use different ports. A second conversation in the same
project does not automatically become its receiver.

**Assign this chat** deliberately moves the binding to the currently selected
saved chat. Verified extension rollovers transfer the existing binding and
pending inbox only after the continuation prompt is observed in the new chat;
the endpoint stays unchanged. A one-time handoff token ties confirmation to the
claimed destination tab. Navigation alone cannot transfer the binding. Temporary new-chat URLs are not
accepted as final destinations. An unverified rollover blocks delivery.

The background worker stores bindings and events in `logicServerLinks`, separate
from heartbeat settings. It reconnects after reload/restart and uses periodic
alarms to recover disconnected sockets. Live connections exchange a keepalive
every 20 seconds; this does not send chat messages. Offline agents cannot run:
events wait in the durable server outbox or extension inbox.

An ordinary Chrome background-worker restart verifies the existing chat page,
setup ID, and page instance, then resumes waiting without resending instructions.
A chat or extension reload that loses the live setup state cannot resume that
conversation safely; inspect it and use Recover connection. Completed bindings
reconnect using the saved credential. A chat reload still follows the existing
Logic Mode/heartbeat Resume rules.

## Server contract

The generated prompt in `server-link.js` is the authoritative, versioned
integration instruction. It supplies project ID, setup ID, a short-lived pairing
token, and the exact permitted `chrome-extension://<id>` WebSocket Origin.

The only supported endpoint is:

```text
ws://localhost:<fixed-port>/.well-known/continue-loop
```

`127.0.0.1` is also supported. No remote addresses, arbitrary paths, URL
credentials, fragments, or query strings are accepted. The server must bind only
to loopback and validate the exact Origin. Plain `ws` is intended only for this
local connection.

All messages are JSON, at most 16 KiB:

- `pair`: extension supplies protocol 1, projectId, setupId, proof, and random
  challenge. The server validates the HMAC proof, generates and persists a random
  credential of at least 32 bytes encoded as hex, consumes the pairing token,
  and returns `paired` with protocol, projectId, setupId, challenge, credential,
  and a server proof that includes the generated credential.
- `auth`: subsequent connections supply protocol, projectId, proof and a
  fresh challenge. The server replies `authenticated` with protocol, projectId,
  challenge and its own proof only after validating the client proof.
- `test`: extension supplies a challenge; server replies `test_ok` with projectId
  and challenge. This generates no business event.
- `ping`: extension supplies a challenge; server replies `pong` with that
  challenge.
- `event`: server supplies projectId, eventId, eventType `form_submitted`, and
  submissionId. IDs must contain 1–128 ASCII letters, digits, `_`, `.`, `:`, or `-`.
  Form contents and arbitrary instructions are not accepted as event payloads.
- `ack`: extension supplies eventId after the event has been persisted. This
  means receipt, not agent completion. Server retries the same event ID until
  ack, retains submissions independently, and tracks completed submission IDs.
- `busy`: extension has 100 pending events; server must retain and retry the
  event with backoff.

Proofs are lowercase hex HMAC-SHA256, keyed by the UTF-8 secret string (not
hex-decoded). Sign the compact UTF-8 JSON array
`[role,projectId,setupId,challenge,credential]`, without whitespace. Pairing uses
the one-time token as key and roles `pair-client` / `pair-server`. Only the server
pairing proof includes the newly generated credential; the client's credential
field is an empty string. Reconnect uses the saved credential as key and roles
`auth-client` / `auth-server`, with both setupId and credential fields empty.
The pairing token and reconnect credential are not sent in client socket frames.
This lets the extension reject a different server that later occupies the port.

The endpoint details are returned in exactly one standalone line from the
assistant's fresh setup response:

```text
[[SERVER_READY:{"protocol":1,"setupId":"<provided ID>","projectId":"<provided project>","endpoint":"ws://localhost:<port>/.well-known/continue-loop"}]]
```

The agent must save the fixed address and event-processing procedure in its
framework/startup documentation. The permanent credential belongs only in
backend configuration and extension storage, never in chat or HTML. Re-pairing
should replace the prior server credential. The extension's public status omits
both credentials and pairing tokens.

The agent must perform routine server configuration and token storage itself
using its authorized tools. The one-time token is intentionally passed in the
setup/recovery chat; saving it elsewhere does not remove that chat copy. Do not
ask the user to run a command merely to keep it out of chat. Consume/remove it
after pairing. The permanent backend credential must never be printed in chat.
If the agent cannot access the server/configuration, it must identify the
missing access and request human input instead of claiming completion.

## Sending and recovery

While working, an event is appended to the next eligible automatic prompt.
While sleeping, an event starts a Logic Mode cycle and suspends heartbeat
wakeups until IDLE. During an explicit `USER_INPUT` wait, a queued event can
resume the same Logic Mode runner without an enabled heartbeat. It sends the
submission reference and asks the agent to check whether the submission answers
the request. The matching Home Assistant request is cancelled and its phone
notification cleared after the event-bearing chat message is confirmed. Other
chats' notifications are unaffected. Phone replies and server input share a
send lock; duplicate wakes cannot start competing sends.

Manual drafts, Pause, Stop, errors, and the message limit prevent event sends.
Missing/invalid Logic flags and pauses caused by manual drafting do not gain this
server-input behavior. Events never overwrite a draft or approve a request.
Queued user instructions remain independent and can accompany the same send.

Each event is claimed durably before editing the composer. It is marked delivered
only after a matching new user turn is observed. Failure before attempting Send
returns it to the queue; failure after Send holds it as uncertain. A worker or
page restart during a claim also holds it. These events appear in the popup:
inspect the chat and select **Already delivered** or **Not sent — retry**.

The extension retains the last 2,000 completed event IDs for duplicate suppression.
The server must also implement durable idempotency by submission ID; this is not
an exactly-once execution guarantee. Form submission success must not depend on
the notification connection being available.

## Compatibility and test boundary

The public beta preserves the existing storage and protocol identifiers. Disable
server connections before a planned downgrade; take care with pending/uncertain
events before enabling them again. Uninstalling or clearing extension storage loses
bindings. Existing settings export does not include this inbox or its credentials.

Automated tests exercise protocol validation, worker routing/storage, pairing,
transport tests, duplicate suppression, uncertain sends, rollover, popup controls,
and content-script setup/sending using simulated Chrome, DOM and WebSocket APIs.
They are not a live ChatGPT or real agent-server test. The first installed test
should use one project and one harmless form submission, checking both chat
delivery and server-side processed-submission tracking.
