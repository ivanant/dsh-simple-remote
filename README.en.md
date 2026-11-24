# dsh-simple-remote

[中文](README.md) | English

A single plugin is all it takes to reach DSH from your phone. Install and it just works — no configuration needed.

Tailscale alone does the networking: any device with it installed joins the tailnet and can reach the others.
Open the DeepSeek Harness Web GUI (the web version, or the one built into the Desktop app) **only** to this machine's Tailscale tailnet:
start a second listening port on the Tailscale interface address and reverse proxy it to the GUI on loopback.
A phone that is on the tailnet then simply opens the page and it works, while other devices on the LAN, in WSL,
or on a virtual adapter cannot even see the port.

## What it does

```
phone (Tailscale) ──►  100.x.y.z:3080   ┐
                                        │ dsh-simple-remote reverse proxy (rewrites Host/Origin to loopback)
local browser     ──►  127.0.0.1:3080  ─┴─►  dsh's own Web server (still bound to loopback only)
```

- It does **not** change the bind of dsh's own Web server: that server still listens on `127.0.0.1` only, so neither
  the LAN nor the virtual adapters are exposed.
- It does **not** loosen the shipped Host/Origin fence: the proxy rewrites the forwarded Host to the loopback
  address, so no new "trusted authority" is added. `Origin` is rewritten only when it was same-origin with the
  request that arrived, and a cross-site request keeps its own Origin and is refused (403) by the fence.
- It **keeps** the shipped authentication: session cookies and `/api` token checks are unchanged; the proxy merely
  performs the first login for you (`autoToken`).
- WebSocket (terminal, remote streams) and SSE event streams pass through untouched.

## Install

npm (default)

```
dsh plugin --profile web add dsh-simple-remote@latest
```

From GitHub

```
dsh plugin --profile web add github:ivanant/dsh-simple-remote
```

Or install the package named `dsh-simple-remote` from the "Plugins" page of the Web GUI.

After installing:

- A new Loader row `simple-remote` appears (package name `dsh-simple-remote`).
- Two lines show up in the startup log:
  `dsh web: tailnet http://100.111.128.100:3080 (Tailscale; auto-login)`
  `dsh web: tailnet name http://dev.tail3b32bf.ts.net:3080/ (MagicDNS)`
  The second one is the full MagicDNS name, and only appears when it still resolves to this machine.
- Settings → General gains a "Phone access (Tailscale)" row that leads with the MagicDNS name, keeps the numeric
  address underneath as a fallback, and copies either in one click.

On the **phone**: connect to Tailscale and open `http://<machine>.<tailnet>.ts.net:3080/` directly
(for example `http://dev.tail3b32bf.ts.net:3080/`). The plugin completes the login on the first visit (see below),
and the browser then remembers it for 30 days.

### Desktop

The Desktop app runs the very same Web application underneath (`--no-open --host 127.0.0.1 --port 0`), so its
loopback port changes on every launch. The plugin therefore pins the **phone-side port at 3080** by default, which
keeps the phone address stable.

Install into the desktop profile:

```
dsh plugin --profile desktop add dsh-simple-remote
```

Or install it from the Desktop app's "Plugins" page. No configuration is needed afterwards: the phone opens
`http://<tailnet address>:3080/`.

## Configuration

Row config lives in `cordis.patch.yml` (after installing it is
`~/.dsh/profiles/web/node_modules/dsh-simple-remote/cordis.patch.yml`; you can also override it from the profile's
own patch layer — note that a patch replaces the whole `config`, so every key you want to keep must be restated):

```yaml
- id: simple-remote
  name: dsh-simple-remote
  config:
    enabled: true # false = off entirely, no tailnet port is opened
    autoToken: true # see "Security"
    address: "" # empty = detect the Tailscale address (100.64.0.0/10); or pin an address or MagicDNS name
    port: 3080 # the fixed phone-side port; 0 mirrors the loopback GUI's port instead
    log: true # also print the address line to the dsh process output
```

The port is bound on the Tailscale address only, so the phone-side 3080 does not clash with a loopback 3080.
One tailnet port can belong to one instance at a time: to expose both a web profile and the Desktop app, give one of
them another number (for example 3081).

## Security

`autoToken: true` (the default) means: **anyone who can connect to this port has full control of this machine**
(arbitrary command execution). The boundary therefore rests entirely on Tailscale — only your own tailnet devices
can connect, and Tailscale's ACLs and device authorization are that door. On a shared tailnet (a team, a family),
set `autoToken: false`:

```yaml
- id: simple-remote
  name: dsh-simple-remote
  config:
    autoToken: false
```

The phone must then open the full `?token=…` link (copy it from the startup log or the settings row), and its
behaviour is exactly that of the loopback address; a tailnet device that does not know the token only gets a 401.

The token is read newest-first: a current Host publishes its tokenized entry URL through the
`webserver/entry-url` event and the plugin takes it from that table; on older Hosts without the event it falls back
to `connection.authenticatedUrl()`. When neither exists, auto-login stays off and the log says so once.

Under the **Desktop** app the loopback port changes on every launch, so the session cookie stops matching: with
`autoToken: true` the phone simply signs in again; with `autoToken` off you must copy a fresh tokenized link after
every Desktop restart.

In either mode the port is bound to the Tailscale address alone — `0.0.0.0` is never used — so devices on the LAN
or a public network cannot reach it. That is also the red line behind dsh's official refusal of `--host 0.0.0.0`.

## Verification

`node test/smoke.mjs` runs the plugin itself outside the Harness (17 checks): the browser half's factory and
rendering (auto-login, token and disabled states, the MagicDNS name leading with the address as a copyable fallback,
the busy-port notice), the proxy's token redirect, cookie pass-through, `/api` Host/Origin rewriting, a cross-site
Origin left untouched, the WebSocket upgrade, page-state injection, the `webserver/entry-url` token source, the
busy-port report, and the listener closing on disposal.

It was also exercised against a live Harness (reached from this machine through the Tailscale address):

| Check                                                    | Result                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Listening addresses                                      | `100.111.128.100:3080` (plugin) + `127.0.0.1:3080` (dsh's own, unchanged) |
| Navigation without a cookie (`Sec-Fetch-Mode: navigate`) | 200, the 35 KB index page, and a `dsh-auth-…` session cookie              |
| `POST /api/<unknown endpoint>` (with cookie)             | 404 — the Host/Origin fence and authentication both passed                |
| Same, without a cookie                                   | 401                                                                       |
| Same, with `Origin: https://evil.example`                | 403                                                                       |
| Plugin asset `plugins/??dsh-simple-remote/client.js`     | 200                                                                       |
| WebSocket `GET /api/remote.mux` (with / without cookie)  | 101 / 401                                                                 |
| Loopback `http://127.0.0.1:3080/` (no cookie)            | 401, as before the plugin was installed                                   |

Only one item could not be verified on this machine: **a real connection from another device (a phone) over the
network**, because the local firewall rules require administrator rights to inspect. If the phone times out, see the
troubleshooting table below.

## Troubleshooting

| Symptom                                                                    | What to do                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The phone cannot connect, and this machine cannot reach the address either | Check the dsh log for `simple-remote: ... listener failed`; confirm Tailscale is connected and this machine has a `100.x.y.z` address                                                                                                                                                                                                                                                                                   |
| The log says "no Tailscale address found"                                  | Tailscale is not running, or the address is outside `100.64.0.0/10`; pin it with the `address` config                                                                                                                                                                                                                                                                                                                   |
| This machine works, the phone times out                                    | Windows Firewall is blocking inbound. In an administrator PowerShell (replace `<node.exe path>` with the output of `where.exe node`): `New-NetFirewallRule -DisplayName "DSH Tailscale Remote" -Direction Inbound -Program "<node.exe path>" -Action Allow -Profile Any`; or allow just the port: `New-NetFirewallRule -DisplayName "DSH Web Tailscale" -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow` |
| The phone shows 401                                                        | `autoToken` is off; open the link with `?token=` once. If `autoToken: true` still returns 401, look for "auto-login is inactive" in the log: this Host published no token                                                                                                                                                                                |
| The phone cannot open a short name such as `workspace` or `dev`            | A short name needs the OS to append the tailnet search domain, which phone resolvers (Android especially) usually do not. Use the **full** MagicDNS name the plugin prints (`<machine>.<tailnet>.ts.net:3080`). If a short name resolves to a different machine, another device (or a node that was never cleaned up) owns that name in the tailnet — check, rename or delete it in the admin console |
| The page opens on the phone but API calls return 403                       | You are using a different host name or address (for example a renaming reverse proxy); add `--trusted-host` or use the address the plugin prints                                                                                                                                                                                                                                                                        |
| The log says "port 3080 ... already in use"                                | Another process owns the phone-side port (typically another DSH instance that also has this plugin). The plugin never steals it or picks another port — it only reports the conflict. Stop that listener or set `port` to another number (for example 3081). Settings → General shows the same notice |
| You want another port                                                      | Change `port`. The default is the fixed 3080, no longer the loopback port; `port: 0` restores mirroring                                                                                                                                                                                                                                                 |

## Picking up code changes

- `client.js` (the settings row): just refresh the page — the browser re-fetches plugin assets.
- `index.js` (the proxy half): ESM modules are cached, so **dsh must be restarted** (or the bundle disabled and
  re-enabled on the Plugins page) before the new code loads. Run `node test/smoke.mjs` before changing it, and do not
  feed broken code to a running server.

## Known limits

- Only IPv4 tailnet addresses are supported (Tailscale always assigns one in `100.64.0.0/10`).
- The phone gets plain HTTP, which is not a secure context (Tailscale HTTPS certificates need another mechanism,
  such as `tailscale serve`). The features tested here are unaffected, but browser APIs that require a secure
  context (for example Service Workers) are unavailable.
- The address is detected once at startup; after Tailscale changes it, dsh must be restarted (or the plugin row
  reloaded).
- The MagicDNS name is looked up once, after the listener is up (directly from `100.100.100.100`, 1.2 s timeout) and
  verified by resolving it back to the same address; when that fails only the numeric address is shown, and access
  is unaffected.
- With a fixed phone-side port only one instance can expose it at a time (see "Configuration"); a busy port is
  reported, never worked around.
