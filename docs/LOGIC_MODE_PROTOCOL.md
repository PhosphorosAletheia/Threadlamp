# Logic Mode protocol

This reference describes the assistant response markers used by Threadlamp
1.9.7 beta 1. Selecting **Start logic** sends the operating instructions to the
conversation automatically. No separate setup prompt or framework file is required.

## Activation and response format

Markers apply while Logic Mode is active. A shutdown message ends marker output.
Each response ends with one control marker on its own final line, outside code
fences. No text follows it. An input request also has a brief line immediately
before its control marker.

| Marker | State |
| --- | --- |
| `[[LOGIC:CONTINUE]]` | More authorized work is ready; Threadlamp can send the configured follow-up. |
| `[[LOGIC:WAIT:15m]]` | An operation is running; request status after the specified delay. Use a whole number from 1 to 120 minutes. |
| `[[LOGIC:IDLE]]` | The current cycle is complete; sleep until a heartbeat or new input. |
| `[[LOGIC:USER_INPUT]]` | A human decision, information, or action is needed. |

An input request has this form:

```text
Which output format should I use?
[[LOGIC:BRIEF: Choose the output format.]]
[[LOGIC:USER_INPUT]]
```

The brief is a single plain-text line of at most 240 characters, with no brackets
inside the summary. It may appear in a phone notification, so it should omit
secrets and unnecessary private details.

WAIT is for an operation already running. IDLE is for completed cycles or work
that is not yet due. Follow-up messages, heartbeats, and markers do not grant
additional authority or answer a pending approval request.

## Cycles and queued instructions

Heartbeats start new cycles with new follow-up counters. IDLE can create an hourly
schedule for a saved chat with no schedule; explicitly paused, disabled, or blocked
schedules remain off. Chrome must remain available for scheduled work.

Queued text appears under “Additional instructions from the user for this round:”
in the next eligible automatic message. It applies to that turn and is consumed
once. Pause, Stop, input-request holds, and message limits still govern dispatch.

For agents with persistent task files, checkpoints help avoid duplicate work
after a status check, interrupted delivery, or conversation rollover. Useful state
includes the objective, completed actions, pending operation references, unresolved
questions, and next step. Availability of prior chat context depends on the agent's
environment.

## Local server integration

The [local server protocol](../SERVER_CONNECTION.md) defines setup, pairing, and
event delivery. Setup messages carry a unique `SERVER_SETUP_REQUEST` tag;
responses use the supplied setup and project IDs in a fenced `SERVER_READY` line.
The request tag is not echoed in the response. Pairing tokens and permanent
credentials stay out of the reply.

A server event contains a submission reference. Its contents are input data,
and receipt does not grant approval or establish that the submission was processed.
Agents retrieve the submission through their configured access and track completed
submission IDs to avoid repeated actions.

See the [user guide](../USER_GUIDE.md) for controls and scheduling details.
