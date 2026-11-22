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
  一键启动 / 停止 / 重启、查看日志、端口冲突检测、接管已在运行的进程。启动和重启
  会等端口真正开始监听才返回（最长 25 秒），不会出现“看着没起来、其实还在启动”。
- **反向代理**：Caddy 作为统一入口。面板里配路由（路径或 Host → 上游，可选
  剥离前缀、Basic 认证、CORS、重定向、静态文件），也可以直接编辑整份
  `Caddyfile`，或写 `custom/*.caddy` 片段。
- **先校验再生效**：改路由会重新生成 Caddyfile → `caddy validate` → 失败自动
  还原 → `caddy reload`。写错一行不会把代理改挂。
- **启动方式**：手动 / 随机 DSH / 登录脚本 / Windows 服务，后两种可在面板里一键切换，
  每个服务和 Caddy 本身都可以单独选。
- **注册 Windows 服务**：安装时用系统自带的 `csc.exe` 编译一个几十行的服务宿主
  （`assets/ServiceHost.cs`），不需要第三方二进制；注册时弹一次 UAC，成功后进
  `services.msc`，开机即启、不依赖登录。
- **对 agent 友好**：五个工具覆盖同样能力，直接说「把 /docs 反代到 8091 并加个
  密码」就能落地。

## 两种自启机制

| | 登录脚本 | Windows 服务 |
|---|---|---|
| 何时启动 | 用户**登录后** | **开机即启**，不需要登录 |
| 注册权限 | 不需要管理员 | 需要管理员（面板会弹 UAC） |
| 在哪儿看 | `HKCU\…\Run\DSHServiceManage` → `autostart\start-all.vbs` | `services.msc` 里的 `DSH-ServiceManage-caddy`、`DSH-ServiceManage-<id>` |
| 运行身份 | 当前用户 | LocalSystem |
| 谁负责启动 | 生成的 `start-all.cmd` | 自带服务宿主 `ServiceHost.exe` |
| 互斥关系 | 已被服务接管的服务/ Caddy 不会再写进登录脚本 | 同左 |

面板里每个服务行有一个下拉框（手动 / 登录脚本 / Windows 服务），设置页有
「Caddy 自启方式」的同款下拉框。切换时会先停掉当前进程，再由另一种方式接管，
然后重新生成登录脚本——两个机制不会同时启动同一个东西。

> Windows 不允许 `cmd.exe /c xxx.cmd` 直接当服务（SCM 握手超时，报 1053），
> 所以插件自带一个最小的 C# 服务宿主：它完成 SCM 握手、拉起 launcher、把输出
> 写到 `launcher.service.log`，停止时用 `taskkill /T` 杀掉整棵子进程树。

## 面板

侧栏「服务」入口，五个页签：

| 页签 | 内容 |
|---|---|
| 概览 | Caddy 与服务状态、快捷启停、最近状态 |
| 服务 | 每条服务的命令、端口、PID、健康检查；启动/停止/重启/日志/编辑/注册 Windows 服务/删除 |
| 反代 | 路由列表（路径 → 上游，Basic/CORS/剥前缀标记），保存即校验重载 |
| 高级 | 整份 Caddyfile 编辑、校验、托管/手动切换、自定义片段 |
| 设置 | 监听地址、管理接口、caddy 路径、随 DSH 启动、开机自启，一键打开数据目录 / 插件目录 / Caddyfile 目录（用 shell 的 `Explore` 打开，复用可见窗口并置前） |

切换自启方式要等 UAC 和 SCM，面板在这类操作进行时会盖一层遮罩并禁用控件，
避免连点造成状态不一致。

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
  windows-service/ServiceHost.exe  自带服务宿主（首次注册时用 csc 编译）
  windows-service/<id>/      launcher.cmd + install.ps1 + uninstall.ps1 + 服务日志
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
