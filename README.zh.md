# dsh-service-manage · 本地服务管理

[English](README.md) | 中文

给 DeepSeek Harness 用的本地服务管理面板：一个面板 + 一组 agent 工具，统一
启停本地进程、用 Caddy 做反向代理，并把它们挂到开机自启或随 DSH 启动。

```
浏览器 ── DSH Web GUI ──► /service-manage（API）
                              │
                        ┌─────┴──────┐
                        │  进程监管   │──► python main.py :8090
                        │  + Caddy   │──► caddy :8080 ──► /image、/v1 …
                        └────────────┘
```

## 功能

- **服务登记表**：名称、说明、工作目录、启动命令、端口、健康检查路径、环境变量；
  一键启动 / 停止 / 重启、查看日志、端口冲突检测、接管已在运行的进程。
- **反向代理**：Caddy 作为统一入口。面板里配路由（路径或 Host → 上游，可选
  剥离前缀、Basic 认证、CORS、重定向、静态文件），也可以直接编辑整份
  `Caddyfile`，或写 `custom/*.caddy` 片段。
- **先校验再生效**：改路由会重新生成 Caddyfile → `caddy validate` → 失败自动
  还原 → `caddy reload`。写错一行不会把代理改挂。
- **启动方式**：手动 / 随机 DSH 启动 / 登录时自启（`HKCU\…\Run` + 隐藏启动脚本）。
  DSH 重启后，标记为「登录自启」的服务会在 6 秒内自动补起。
- **注册 Windows 服务**：生成可直接以管理员运行的 `install.ps1` / `uninstall.ps1`；
  已有管理员权限时直接执行，没有就告诉你脚本在哪。
- **对 agent 友好**：五个工具覆盖同样能力，直接说「把 /docs 反代到 8091 并加个
  密码」就能落地。

## 面板

侧栏「服务」入口，五个页签：

| 页签 | 内容 |
|---|---|
| 概览 | Caddy 与服务状态、快捷启停、最近状态 |
| 服务 | 每条服务的命令、端口、PID、健康检查；启动/停止/重启/日志/编辑/注册 Windows 服务/删除 |
| 反代 | 路由列表（路径 → 上游，Basic/CORS/剥前缀标记），保存即校验重载 |
| 高级 | 整份 Caddyfile 编辑、校验、托管/手动切换、自定义片段 |
| 设置 | 监听地址、管理接口、caddy 路径、随 DSH 启动、开机自启 |

## 安装

本目录就是插件包：

1. 打开 DSH 的 **插件** 页；
2. 选择 **添加插件**，指向本目录；
3. 启用 `service-manage` 这一行，侧栏出现 **服务** 入口。

需要 `caddy` 在 `PATH` 里（或在面板/配置里填绝对路径）。数据目录默认
`<DSH_HOME>/service-manage`。

> 激活插件不会启动任何进程：Caddy 只在「随 DSH 启动」打开时才会被拉起，
> 而且 2019/8080 被占用时直接放弃，不会起第二个实例。

## 配置（bundle 行）

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH_HOME>/service-manage` | 登记表、日志、生成的 Caddyfile |
| `caddyExe` | `caddy` | 可执行文件；找不到会自动试 winget 安装路径 |
| `caddyfile` | `<dataDir>/caddy/Caddyfile` | 主 Caddyfile |
| `proxyListen` | `:8080` | 反代监听地址 |
| `adminEndpoint` | `localhost:2019` | Caddy 管理接口（`admin localhost:2019` 只认这个 Host） |
| `autoStartCaddy` | `false` | DSH 启动时是否顺带拉起 Caddy |

其余设置都在面板里改，存进 `state.json`。

## 两种 Caddy 模式

- **托管**（默认）：`Caddyfile` 由面板生成，`import routes/_managed.caddy`
  （路由渲染结果）和 `custom/*.caddy`（手写片段），末尾兜底 404。
- **手动**：整个 `Caddyfile` 归你，面板直接编辑；结构化路由只记录不渲染。
  随时可以切回托管模式重新生成（旧文件先备份为 `*.bak`）。

单个路由的渲染结果，例如「`/image` → 8090，剥前缀」：

```caddyfile
@svc_image {
	path /image*
}
handle @svc_image {
	uri strip_prefix /image
	reverse_proxy 127.0.0.1:8090
}
```

## 试一下

```text
service_config  { action: "upsert", id: "image-api", name: "生图 API",
                  cwd: "D:\\services\\image-api", command: "\"F:\\Miniconda3\\python.exe\" main.py",
                  port: 8090, healthPath: "/health", autoStart: "boot" }
service_control { id: "image-api", action: "start" }
proxy_route     { action: "upsert", path: "/image", upstream: "127.0.0.1:8090", stripPrefix: true }
caddy_config    { action: "snippet-upsert", snippet: { id: "access-log", name: "访问日志",
                  content: "log {\n\toutput file D:/logs/access.log {\n\t\troll_size 10MiB\n\t}\n\tformat console\n}" } }
service_status  {}
```

## 边界

- **Windows 优先**：进程控制用 `taskkill` / `netstat`，自启用注册表，Windows 服务
  用 PowerShell；其他平台只有 Caddy 那一半。
- **进程归属**：插件启动的进程随插件停用/退出而结束；登录自启那套是独立进程，
  不受影响。要长期常驻请用「登录自启」或注册成 Windows 服务。
- **回环限制**：面板 API 只接受本机回环请求，即使 DSH Web 暴露到局域网也不通。
- **单一入口**：一个安装只有一份反向代理监听（`:8080` 或你设置的值）。
- **界面语言**：目前面板文案为中文。

## 数据目录

```
<dataDir>/
  state.json                 服务 / 路由 / 片段 / 设置
  caddy/Caddyfile            主文件（托管模式生成）
  caddy/routes/_managed.caddy 路由渲染结果
  caddy/custom/<id>.caddy    手写片段
  logs/<service>.log         服务输出
  autostart/                 登录自启脚本（start-all.cmd / .vbs / services/*.cmd）
  windows-service/<id>/      Windows 服务安装脚本
```

## 开发

```bash
npm install            # 仅测试用：react + react-dom
node --check index.js && node --check client.js
node test/render.test.mjs      # Caddyfile 渲染、登记表归一化、日志流回归
node test/client-render.mjs    # 用固定数据渲染面板每个页签
node test/smoke-caddy.mjs      # 生成一份贴近真实的 Caddyfile，再用 caddy validate 校验
```

设计取舍见 [DESIGN.md](DESIGN.md)。

MIT 许可。
