# dsh-service-manage · 本地服务管理

给 DeepSeek Harness 用的本地服务管理面板：一个面板 + 一组 agent 工具，统一
启停本地进程、用 Caddy 做反向代理、并把它们挂到开机自启或随 DSH 启动。

```
浏览器 ── DSH Web GUI ──► /service-manage（API）
                              │
                        ┌─────┴──────┐
                        │  进程监管   │──► python main.py :8090
                        │  + Caddy   │──► caddy :8080 ──► /image、/v1 …
                        └────────────┘
```

## 功能

- **服务**：名称、说明、工作目录、启动命令、端口、健康检查路径、环境变量；
  一键启动 / 停止 / 重启、查看日志。
- **反向代理**：Caddy 作为统一入口。面板里配置路由（路径或 Host → 上游，
  可选剥离前缀、Basic 认证、CORS、重定向、静态文件），也可以直接编辑整个
  `Caddyfile`。
- **先校验再生效**：每次改路由都会重新生成 Caddyfile → `caddy validate` →
  `caddy reload`；校验失败自动还原上一份文件，不会把代理改挂。
- **启动方式**：手动 / 随 DSH 启动 / 登录时自启（写 `HKCU\…\Run` + 隐藏启动脚本）。
- **注册 Windows 服务**：生成一份可直接以管理员运行的安装脚本；已经有管理员
  权限时直接执行。
- **对 agent 友好**：`service_status`、`service_control`、`service_config`、
  `proxy_route`、`caddy_config` 五个工具覆盖同样的能力，直接跟 agent 说
  “把 /docs 反代到 8091 并加个密码”就能落地。

## 安装

本目录就是插件包：

1. 打开 DSH 的 **插件** 页；
2. 选择 **添加插件**，指向本目录；
3. 启用 `service-manage` 这一行，侧栏会出现 **服务** 入口。

需要 `caddy` 在 `PATH` 里（或在面板里填绝对路径）。数据目录默认
`<DSH_HOME>/service-manage`，可在插件行配置里用 `dataDir` 改。

## 配置（bundle 行）

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH_HOME>/service-manage` | 登记表、日志、生成的 Caddyfile |
| `caddyExe` | `caddy` | 可执行文件 |
| `caddyfile` | `<dataDir>/caddy/Caddyfile` | 主 Caddyfile |
| `proxyListen` | `:8080` | 反代监听地址 |
| `adminEndpoint` | `127.0.0.1:2019` | Caddy 管理接口 |

其余设置都在面板里改，存进 `state.json`。

## 两种 Caddy 模式

- **托管**（默认）：`Caddyfile` 由面板生成，`import routes/_managed.caddy`
  （路由渲染结果）和 `custom/*.caddy`（手写片段），末尾兜底 404。
- **手动**：整个 `Caddyfile` 归你，面板直接编辑；结构化路由只记录不渲染。
  随时可以切回托管模式重新生成。

## 试一下

```text
service_config  { action: "upsert", id: "image-api", name: "生图 API",
                  cwd: "D:\\services\\image-api", command: "\"F:\\Miniconda3\\python.exe\" main.py",
                  port: 8090, healthPath: "/health", autoStart: "dsh" }
service_control { id: "image-api", action: "start" }
proxy_route     { action: "upsert", path: "/image", upstream: "127.0.0.1:8090", stripPrefix: true }
service_status  {}
```

## 边界

- Windows 优先：进程控制用 `taskkill`/`netstat`，自启用注册表，Windows 服务用
  PowerShell；其他平台只有 Caddy 那一半。
- 由插件启动的进程会随插件退出而结束；要长期常驻请用「随 DSH 启动」或注册成
  Windows 服务。
- 面板 API 只接受本机回环请求。
- 一个安装只有一份反向代理监听。

## 开发

```bash
node --check index.js && node --check client.js
node test/render.test.mjs
```

MIT 许可。
