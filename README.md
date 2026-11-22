# dsh-service-manage

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
  health path, extra environment; start, stop, restart, read logs.
- **Reverse proxy**: Caddy is the entry point. Add routes (path/host → upstream,
  optional prefix stripping, Basic auth, CORS, redirect, static files) from the
  panel, or edit the whole `Caddyfile` by hand.
- **Validation first**: every route change re-renders the Caddyfile, runs
  `caddy validate`, then reloads. A failed validation restores the previous
  files, so a typo cannot take the proxy down.
- **Startup modes**: manual, start with DSH, or start at user login
  (`HKCU\…\Run` + a generated hidden launcher).
- **Windows service**: generates a ready-to-run elevated install script
  (and runs it when you are already elevated).
- **Agent-friendly**: five tools — `service_status`, `service_control`,
  `service_config`, `proxy_route`, `caddy_config` — cover the same operations,
  so asking the agent to "put /docs on 8091 with a password" works.

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
| `adminEndpoint` | `127.0.0.1:2019` | Caddy admin API |

Everything else is edited in the panel and stored in `state.json`.

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
- Processes started by the plugin die with it; use `autoStart: "dsh"` or a
  Windows service when they must outlive DSH.
- The panel API answers loopback requests only.
- One proxy listener per installation.

## Development

```bash
npm install            # dev-only: react + react-dom for the render test
node --check index.js && node --check client.js
node test/render.test.mjs      # Caddyfile rendering, store normalization, log-pipe regressions
node test/client-render.mjs    # renders every panel tab against a fixture
node test/smoke-caddy.mjs      # prints a realistic Caddyfile; validate with `caddy validate --config .smoke/caddy/Caddyfile`
```

MIT licensed.
