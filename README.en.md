# dsh-simple-remote

[中文](README.md) | English

A single plugin is all it takes to reach DSH from your phone. Install and it just works — no configuration needed.

Tailscale alone does the networking: any device with it installed joins the tailnet and can reach the others.
Open the DeepSeek Harness Web GUI (the GUI of `dsh --profile web`) **only** to this machine's Tailscale tailnet:
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
- One line shows up in the startup log:
  `dsh web: tailnet http://100.111.128.100:3080 (Tailscale; auto-login)`
- Settings → General gains a "Phone access (Tailscale)" row that shows the address and copies it in one click.

On the **phone**: connect to Tailscale and open `http://<your tailnet address>:3080/` directly.
The plugin completes the login on the first visit (see below), and the browser then remembers it for 30 days.

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
    port: 0 # 0 = mirror the loopback GUI's port (3080 by default)
    log: true # also print the address line to the dsh process output
```

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

In either mode the port is bound to the Tailscale address alone — `0.0.0.0` is never used — so devices on the LAN
or a public network cannot reach it. That is also the red line behind dsh's official refusal of `--host 0.0.0.0`.

## Verification

`node test/smoke.mjs` runs the plugin itself outside the Harness (13 checks): the browser half's factory and
rendering (auto-login, token and disabled states, plus the copy button), the proxy's token redirect, cookie
pass-through, `/api` Host/Origin rewriting, a cross-site Origin left untouched, the WebSocket upgrade, page-state
injection, and the listener closing on disposal.

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
| The phone shows 401                                                        | `autoToken` is off; open the link with `?token=` once                                                                                                                                                                                                                                                                                                                                                                   |
| The page opens on the phone but API calls return 403                       | You are using a different host name or address (for example a renaming reverse proxy); add `--trusted-host` or use the address the plugin prints                                                                                                                                                                                                                                                                        |
| You want another port                                                      | Change `port`, or run `dsh --profile web --port 8080` (the plugin follows the loopback port by default)                                                                                                                                                                                                                                                                                                                 |

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
