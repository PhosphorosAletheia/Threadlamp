# Security reporting

Do not post secrets or exploit details in public issues. Use
[private vulnerability reporting](https://github.com/PhosphorosAletheia/Threadlamp/security/advisories/new)
when available.

If the option is unavailable, open only a nonsensitive issue asking for a private
reporting channel. Keep vulnerability details private until that channel exists.
Do not attach settings backups, tokens, full chat URLs or conversation transcripts.

Include the extension and browser versions, an isolated reproduction with
invented data, expected behavior and actual behavior. The current beta is the
supported target; no response-time guarantee is offered.

The beta depends on ChatGPT's web interface. Page changes may affect send guards,
rollover or status detection. Review important actions and pause on uncertainty.

## LAN helper access

LAN dashboard access grants agent control, including prompt submission and
approval actions. Protect its generated access key like a remote-control
credential. Keep the helper on a trusted private network, use HTTPS, verify the
certificate fingerprint on clients, and do not expose it to the public internet.
The bridge binds only to loopback and requires a separate pairing token.
The helper enforces host/origin checks and an explicit dashboard-operation
allowlist. Existing command target validation and receipts remain in force.
See [LAN setup](LAN_DASHBOARD.md) for revocation and key rotation.
