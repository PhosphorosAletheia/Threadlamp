# LAN dashboard

The optional helper lets you use Threadlamp's dashboard from another computer,
phone, or tablet on your private network. It includes message queues, broadcasts,
Logic Mode controls, heartbeat schedules, and project-server controls. Chrome,
the extension, and the helper must stay running on the host computer.

LAN access is disabled until you pair the extension. The helper uses HTTPS and a
separate sign-in key. Anyone with that key can view dashboard information and
control your agents, including sending prompts and approving work.

## Set up the host

Use the **source ZIP** or repository checkout; the extension ZIP does not include
the Node helper. Install a supported Node.js LTS release and OpenSSL. Run these
commands from the source directory:

```sh
npm ci --ignore-scripts
npm run lan -- init --host <host-private-IPv4-address>
npm run lan -- start
```

Replace `<host-private-IPv4-address>` with this computer's LAN address. Setup
accepts private IPv4 addresses and binds only to the address you choose. Use a
stable address or DHCP reservation. The defaults are HTTPS port **8443** and
local bridge port **3211**. You can set `--port` and `--bridge-port` during setup.

Setup writes a private directory at `~/.config/threadlamp-lan`. It contains the
TLS certificate and key, configuration, and `pairing.txt`. Open that file locally
to find the dashboard URL, dashboard access key, extension pairing token, and
certificate fingerprint. Do not paste these credentials into chats or commit
them. The dashboard and extension use different keys.

In Threadlamp's extension settings, find **LAN dashboard helper**. Enter the
local bridge port and extension pairing token, then select **Save & connect**.
Allow the requested loopback permission. The status should say the helper is
connected. Pair only one Chrome profile to each helper.

## Connect from another device

1. Open the HTTPS dashboard URL shown by setup.
2. Setup creates a self-signed certificate. Compare its SHA-256 fingerprint with
   the fingerprint printed on the host before trusting it on your device. Your
   browser or device may require installing/trusting that certificate. Do not
   disable certificate checks globally.
3. Sign in with the **dashboard access key** from `pairing.txt`.

If a host firewall blocks access, allow the chosen HTTPS port from your trusted
LAN only. The extension bridge stays on `127.0.0.1`; do not forward it. Do not
publish the helper through a router port forward or public tunnel.

The dashboard controls agents in the host's Chrome profile. **Open chat on host**
and **Open settings on host** open those pages on that computer. Sound tests play
there too. Home Assistant and other connection credentials stay in extension
settings; they are not editable through the LAN dashboard.

## Install on Android

The LAN dashboard includes an installable web app with a full-screen launch mode.
Open its HTTPS address in Chrome on your Android device, sign in, then use
**Settings → Install Threadlamp** in the dashboard. Installation is also available
from the sign-in page. When Chrome does not offer a prompt, use its menu:
**Add to Home screen → Install**. Launch Threadlamp from the new home-screen icon.

The phone must trust the HTTPS certificate without a certificate warning. Merely
bypassing a warning does not establish trusted HTTPS for installation. For a private
certificate, verify its fingerprint on the host before installing trust on your
phone; use your device's certificate settings. Never transfer `server-key.pem`,
the extension pairing token, or the entire private helper directory to the phone.
Browser/device support and access to a private LAN origin can affect installation;
if only a browser shortcut is offered, it may not launch full screen. Android
installation must be checked on your actual device.

The app stays on your LAN and uses the same sign-in and session expiry as the
browser dashboard. Chrome, the extension, and the helper still run on the host.
It has no offline command queue, background sync, or service-worker cache of
agent data. Restart the helper after updating its source, then reopen the app;
reloading the extension is unnecessary for a helper-only update.

## Disconnect and recover

- Choose **Sign out** on a shared device. Sessions expire after 12 hours and
  are invalidated when the helper restarts. Unsent drafts remain on screen after
  expiry so you can save them before signing in again.
- Choose **Disable LAN access** in extension settings to revoke the bridge, or
  stop the helper with Ctrl+C. Disabling preserves the saved pairing token.
- If a command times out or disconnects, inspect the agent before retrying. The
  helper does not queue commands while offline or replay uncertain commands.
- Reloading the extension can invalidate already-open chat controls. Follow the
  normal extension update procedure; the helper does not reload chat pages.
- Setup refuses to overwrite existing credentials. To rotate keys, stop the
  helper and initialize a new private directory using `--dir <new-directory>`.
  Start with that same `--dir`, update the extension pairing, and use the new
  dashboard access key. Old sessions stop working with the old helper stopped.
- Certificates last one year. Generate a new setup and pair again before expiry,
  or replace the certificate and key in the stopped helper's private directory
  with a certificate valid for the configured address. Preserve owner-only key
  permissions and verify the replacement certificate on clients.

The helper does not install a startup service or change your firewall. Run it in
a terminal for the beta. It needs no administrator access. Extension settings
backups do not include the LAN pairing token; keep the private helper directory
secure if you back it up separately.

## Data and transport

Dashboard state, queued message text, summaries, heartbeat prompts, and commands
travel over HTTPS between the device and helper, then over an authenticated
loopback WebSocket to Chrome. The helper keeps sessions and pending requests in
memory. It does not log or save message bodies. The existing extension continues
to store its normal settings and dashboard history.

The helper accepts an explicit set of dashboard operations. Existing conversation,
page-instance, revision, and command-receipt checks still apply. It cannot serve
arbitrary source/configuration files or proxy arbitrary extension messages.
