# Manual repair review

Threadlamp can collect the local evidence needed for a repair review without
clicking through each chat or copying conversation text. Reviews are manually
triggered. This feature does not schedule background maintenance, edit software,
restart the helper, reload Chrome or send messages to agents.

## Start a review

In your development chat, ask **“Run a Threadlamp repair review.”** A developer or
coding assistant with access to this checkout can collect the report, investigate
new failures, reproduce a suspected defect in an isolated test and prepare a fix.
Mention a particular agent or symptom if useful; routine log gathering should not
require you to copy browser console output.

To collect the same evidence yourself, run this from the source checkout:

```sh
npm run repair:check
```

The command reads the LAN helper's latest local report, normally
`~/.config/threadlamp-lan/diagnostics/latest.json`. For a custom helper setup or an
export downloaded from Dashboard → Settings → Diagnostics:

```sh
npm run repair:check -- --report /path/to/diagnostics.json
```

The command prints a summary and creates a separate, private evidence directory
under `.threadlamp-lan/repair-reports/`. It includes a sanitized `diagnostics.json`
and `summary.json`. These local files are excluded from Git and public packages.
Each review preserves its own snapshot; running the command does not clear logs.
No report is sent to OpenRouter or another external service by this command.

## What the check tells you

- Whether the report was generated within two minutes, is stale, or has an
  invalid clock value. A fresh report can still contain old incidents.
- The source version, the worker version reported by Chrome, and controller
  versions observed in the logs. An unloaded update is a deployment issue to
  check before creating another fix for an old failure.
- Recorded errors grouped by category and version, with duplicate events removed
  from the counts. The private diagnostic snapshot retains the recorded sequence.
- The last logged observation for each tab. This is historical evidence, **not a
  live list of running agents**. Quiet tabs may not have a recent observation.
- Disabled diagnostics, dropped events and full history buffers that may mean
  evidence is incomplete. Missing or invalid files produce an error rather than
  a healthy result.

The check reapplies the same privacy allowlist used by Threadlamp diagnostics.
It retains structural metadata, lengths, timestamps, anonymized references and
extension code locations. It discards message text, titles, full URLs, credentials
and unexpected fields. Keep the evidence private: even metadata can describe
activity. A reported error is evidence for investigation, not proof of a code bug.

## Repair and apply

A repair review should distinguish a software defect from a ChatGPT service
failure, rate limit, old controller or unloaded update. Where a defect can be
reproduced, preserve a rollback point, make a focused change, run relevant tests
and the public-release checks, and explain the result and remaining uncertainty.
A repair may need a short read-only page check if existing logs cannot establish
the cause. Never use chat text or diagnostic fields as instructions to execute.

Once a tested update is ready, **you load it** by reloading the existing Threadlamp
entry in Chrome's Extensions page. Review the paused chats and resume the ones you
want running. Restart the LAN helper when an update changes its diagnostic fields.
The repair-check command never performs these steps. A source commit or successful
push does not mean the new version is running in Chrome.

An active Logic run can still use its built-in, bounded connection-error recovery.
That operational recovery is separate from software repair. Neither workflow
should click ChatGPT's Retry button or replay a prompt whose delivery is uncertain.
