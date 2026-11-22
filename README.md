# dsh-service-manage

English | [中文](README.zh.md)

A local service manager for DeepSeek Harness: one panel and one set of agent
tools to start/stop local processes, put them behind Caddy, and keep them alive.

```
browser ── DSH Web GUI ──► /service-manage (API)
                              │
                        ┌─────┴──────┐
                        │ supervisor │──► python main.py :8090
                        │   + Caddy  │──► caddy :8080 ──► /image, /v1, ...
                        └────────────┘
```

## What it does

- **Services**: name, description, working directory, launch command, port,
  health path, extra environment; start, stop, restart, read logs. Start and
  restart return only once the port accepts connections (up to 25s), so a slow
  boot never looks like a failure.
- **Reverse proxy**: Caddy is the entry point. Add routes (path/host → upstream,
  optional prefix stripping, Basic auth, CORS, redirect, static files) from the
  panel, or edit the whole `Caddyfile` by hand.
- **Validation first**: every route change re-renders the Caddyfile, runs
  `caddy validate`, then reloads. A failed validation restores the previous
  files, so a typo cannot take the proxy down.
- **Startup modes**: manual, start with DSH, the hidden login launcher, or a real
  Windows service. The last two are switchable per entry — services and Caddy
  alike — from the panel.
- **Windows service**: the install compiles a small bundled service host
  (`assets/ServiceHost.cs`) with the `csc.exe` that ships with Windows, so no
  third-party binary is added. A UAC prompt appears once; afterwards the entry
  lives in `services.msc` and starts at boot without a login.
- **Agent-friendly**: five tools — `service_status`, `service_control`,
  `service_config`, `proxy_route`, `caddy_config` — cover the same operations,
  so asking the agent to "put /docs on 8091 with a password" works.

## Two autostart mechanisms

| | Login launcher | Windows service |
|---|---|---|
| Starts | after the user logs in | at boot, no login needed |
| Needs admin | no | yes (the panel raises UAC) |
| Where | `HKCU\…\Run\DSHServiceManage` → `autostart\start-all.vbs` | `services.msc`: `DSH-ServiceManage-caddy`, `DSH-ServiceManage-<id>` |
| Runs as | the signed-in user | LocalSystem |
| Started by | generated `start-all.cmd` | bundled `ServiceHost.exe` |

Each service row has a selector (manual / login launcher / Windows service) and
the settings page has the same selector for Caddy. Switching stops the current
process, hands the entry to the other mechanism, and regenerates the login
script, so the two never start the same thing twice. The panel covers itself
with a busy veil while such a switch runs (after 200 ms, so quick actions do not
flash), which disables the selectors and drops repeat clicks instead of letting
a second switch race the first. The settings page also opens the data directory,
the plugin directory, or the Caddyfile's folder in Explorer: the folder is
opened through the shell (`Shell.Application.Explore`) rather than
`explorer.exe <dir>`, because a window spawned that way from a background
process never becomes visible — it keeps style `0x04CF0000`, shows up in no
Alt-Tab list, and still accepts `SetForegroundWindow`, which is how a "success"
could leave the screen untouched. Only a visible window is reused or raised
(borrowing the foreground thread, since Windows refuses that to a background
process), and leftover invisible windows for the same folder are closed.

> Windows rejects `cmd.exe /c something.cmd` as a service binary — the process
> never talks to the SCM, so start fails with error 1053. The bundled host does
> the SCM handshake, runs the launcher, appends output to
> `launcher.service.log`, and kills the child tree on stop.

## Install

The bundle is a local plugin directory:

1. Open **Plugins** in DSH.
2. Choose **Add plugin** and point it at this directory.
3. Enable the row `service-manage`, then open the **服务** entry in the sidebar.

`caddy` must be on `PATH` (or set `caddyExe` in the panel). The data directory
defaults to `<DSH_HOME>/service-manage`; override it with `dataDir` in the row
config.

## Configuration (bundle row)

| key | default | meaning |
|---|---|---|
| `dataDir` | `<DSH_HOME>/service-manage` | registry, logs, generated Caddyfile |
| `caddyExe` | `caddy` | executable to run |
| `caddyfile` | `<dataDir>/caddy/Caddyfile` | main Caddyfile |
| `proxyListen` | `:8080` | reverse-proxy listen address |
| `adminEndpoint` | `localhost:2019` | Caddy admin API (`admin localhost:2019` answers that Host only) |
| `autoStartCaddy` | `false` | start Caddy when DSH starts |

Everything else is edited in the panel and stored in `state.json`.

## Panel

The sidebar entry **服务** opens five tabs: overview, services, reverse-proxy
routes, an advanced page (whole Caddyfile + custom snippets), and settings.

## Two Caddy modes

- **Managed** (default): `Caddyfile` is generated. It imports
  `routes/_managed.caddy` (rendered from routes) and `custom/*.caddy`
  (hand-written snippets), then answers 404.
- **Manual**: you own the whole `Caddyfile`. The panel edits it directly and
  structured routes are recorded but not rendered. Switch back at any time to
  regenerate.

## Try it

```text
service_config  { action: "upsert", id: "image-api", name: "生图 API",
                  cwd: "D:\\services\\image-api", command: "\"F:\\Miniconda3\\python.exe\" main.py",
                  port: 8090, healthPath: "/health", autoStart: "dsh" }
service_control { id: "image-api", action: "start" }
proxy_route     { action: "upsert", path: "/image", upstream: "127.0.0.1:8090", stripPrefix: true }
service_status  {}
```

## Limits

- Windows-first: process control uses `taskkill`/`netstat`, autostart uses the
  registry, and the Windows-service plan uses PowerShell. Other platforms get
  the Caddy half only.
- Processes started by the plugin die with it; login-launched ones are detached
  and survive. Use `autoStart: "boot"` or a Windows service when they must
  outlive DSH.
- The panel API answers loopback requests only.
- One proxy listener per installation.
- The panel UI is currently Chinese.

## Data directory

```
<dataDir>/
  state.json                  services, routes, snippets, settings
  caddy/Caddyfile             main file (managed mode)
  caddy/routes/_managed.caddy rendered routes
  caddy/custom/<id>.caddy     hand-written snippets
  logs/<service>.log          process output
  autostart/                  login launcher (start-all.cmd/.vbs, services/*.cmd)
  windows-service/ServiceHost.exe  compiled service host (built on first use)
  windows-service/<id>/       launcher + install/uninstall + service log
```

## Development

```bash
npm install            # dev-only: react + react-dom for the render test
node --check index.js && node --check client.js
node test/render.test.mjs      # Caddyfile rendering, store normalization, log-pipe regressions
node test/client-render.mjs    # renders every panel tab against a fixture
node test/smoke-caddy.mjs      # prints a realistic Caddyfile; validate with `caddy validate --config .smoke/caddy/Caddyfile`
```

MIT licensed.
