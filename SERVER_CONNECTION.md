# Local server connection — protocol 1

Threadlamp can deliver project server events to an assigned ChatGPT conversation.
This optional integration requires a compatible server on the computer running
Chrome. A companion server is not included.

## Setup

1. Open the saved ChatGPT conversation that should receive the project's events.
   Finish its current response and clear any draft.
2. In the extension popup, expand **Local server connection for this project**
   and select **Set up connection**. Allow Chrome's loopback host permission.
3. Threadlamp sends integration instructions to the agent, which configures its
   server and returns a `SERVER_READY` block.
4. Threadlamp verifies the endpoint, pairing, and transport, then sends a
   confirmation prompt. Confirmation ends with `[[LOGIC:IDLE]]`.
5. If the chat was already sleeping, its heartbeat resumes. Otherwise select
   **Start logic** or **Start next cycle** to enable event processing.

Setup waits for a finished reply; pauses between tool steps do not end the wait.
It allows up to five follow-ups. The 15-minute setup lease renews while
the same chat page and attempt remain active. Abandoned attempts expire.

A draft, manual pause, active task, or request for human input can prevent setup.
Resolve the condition before retrying. **Stop** or **Disable** cancels setup
without clearing manual text. The popup displays setup errors.

## Recover a connection

After the current reply finishes, select **Recover connection** in the assigned
chat. Recovery reuses the existing service, port, data, and completed work. If the
agent cannot identify the original service, it requests your input.

Recovery retains saved credentials and pending/processed event IDs. Incomplete
pairing uses a fresh one-time token. Each attempt has a new setup ID; an existing
saved endpoint must remain the same. Recovery is also available when extension
settings have been lost, but it cannot restore lost inbox or processed-event
history. The server must keep its own submission records.

Resolve uncertain event deliveries before recovery. A live setup attempt prevents
a competing attempt, and failed setup messages are not replayed automatically.

## Assignment and persistence

A connection uses the stable `g-p-<32 hex digits>` project identifier and the exact
receiving conversation URL. Project names are labels. Different projects can use
different ports; other chats in the same project do not automatically receive events.

**Assign this chat** moves the binding to the selected saved conversation.
Conversation rollover transfers the binding and pending inbox after Threadlamp
confirms its continuation prompt in the new chat. Unverified rollover blocks
delivery; the server endpoint stays unchanged.

Bindings and events are stored locally in `logicServerLinks`. Completed connections
reconnect after browser or worker restarts using their saved credentials. A
20-second keepalive checks the connection without sending chat messages. Events
wait in the server outbox or extension inbox while the agent is unavailable.

If a chat or extension reload interrupts setup, inspect the conversation and use
**Recover connection**. An ordinary background-worker restart can resume setup
while the original chat page and attempt remain active.

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

Store the fixed address and event-processing procedure in the agent's persistent
project configuration. The permanent credential belongs in backend configuration
and extension storage, never in chat or HTML. Re-pairing should replace the prior
server credential. Threadlamp's public status omits credentials and pairing tokens.

The one-time pairing token is supplied in the setup conversation and remains in
chat history. The server consumes it after pairing. Setup requires an agent with
access to the server configuration; missing access pauses setup for user input.

WebSocket upgrades require HTTP/1.1 responses and browser-compatible compression
negotiation. If the server does not support `permessage-deflate`, omit that
response header while accepting otherwise valid upgrades. Preserve Origin and
authentication checks.

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

## Updates and testing

Disable server connections before a downgrade and resolve pending or uncertain
events before re-enabling them. Clearing extension storage or uninstalling loses
bindings. Settings exports do not include server credentials or the event inbox.

For the first integration test, use one project and a disposable form submission.
Check both chat delivery and the server's processed-submission record.
