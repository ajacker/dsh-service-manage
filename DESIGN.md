# 设计：本地服务管理 + Caddy 反代插件

> 先设计再动手。这份文档记录第一版的边界、数据模型和取舍，后续改动请同步更新。

## 1. 目标与不做什么

**要解决的真实问题**：本机有一堆“小服务”（python 脚本、前端、ComfyUI 之类），
现在靠 `.vbs` + 注册表自启，看不见状态、记不住端口、改一次反代要开编辑器。
缺的是**一个能看见、能启停、能让 agent 代改**的地方。

**第一版做**：

1. 服务登记表：名称/说明/工作目录/启动命令/端口/健康检查/环境变量。
2. 进程监管：启动、停止、重启、日志、端口冲突检测、接管已在跑的进程。
3. Caddy 反代：结构化路由（面板）+ 手写片段 + 整份 Caddyfile 三种粒度。
4. 启动方式：手动 / 随 DSH / 登录自启；Windows 服务安装脚本。
5. 五个 agent 工具，覆盖同样的操作。
6. 面板：侧栏一个入口，五个页签（概览/服务/反代/高级/设置）。

**第一版不做**（明确留白）：

- 多反代监听（一个安装一份 `:8080`）。
- 跨平台进程管理（macOS/Linux 只跑 Caddy 那一半）。
- 端口转发、TLS 自动签发（TLS 交给 Cloudflare/前置代理）。
- 会话级状态、事件流（面板轮询 4s 足够）。

## 2. 分层

```
index.js          插件入口：装配 store/supervisor/caddy，注册路由、工具、提示词
lib/store.js      状态文档：settings + services + routes + snippets（state.json）
lib/services.js   进程监管：spawn / taskkill / netstat / 健康检查
lib/caddy.js      渲染 Caddyfile、validate、reload、start/stop、bcrypt
lib/windows.js    登录自启（注册表 + 启动脚本）、Windows 服务安装计划
lib/api.js        同源 HTTP API（/service-manage），回环 fence
lib/tools.js      五个 agent 工具
client.js         浏览器半侧：侧栏图标 + main 面板（React，无构建步骤）
```

**依赖为零**：只用 Node 内置模块，`client.js` 从模块表取 React。这样本目录
既是可安装的插件包，也是可读的源码，不需要 pnpm/打包器。

## 3. 数据模型

`state.json`（位于 `dataDir`，默认 `<DSH_HOME>/service-manage`）：

```jsonc
{
  "version": 1,
  "settings": {
    "proxyListen": ":8080",
    "adminEndpoint": "localhost:2019",
    "caddyExe": "caddy",
    "caddyfile": "",              // 空 = <dataDir>/caddy/Caddyfile
    "autoStartCaddy": false,      // DSH 启动时顺带拉起 Caddy（默认关，避免抢占别人的端口）
    "trustProxyHeaders": true     // trusted_proxies，用于真实客户端 IP
  },
  "caddy": { "mode": "managed" }, // managed | manual
  "services": [{
    "id": "image-api", "name": "生图 API", "description": "…",
    "cwd": "D:\\…\\image-api", "command": "\"F:\\Miniconda3\\python.exe\" main.py",
    "env": { "PORT": "8090" }, "port": 8090, "healthPath": "/health",
    "autoStart": "none|dsh|boot", "manage": "process|external"
  }],
  "routes": [{
    "id": "image", "name": "生图前端", "order": 100, "enabled": true,
    "kind": "proxy|redirect|static",
    "match": { "path": "/image", "exact": false, "host": "" },
    "stripPrefix": true, "upstream": "127.0.0.1:8090",
    "auth": { "type": "basic", "user": "admin", "hash": "$2a$14$…" },
    "cors": true, "headerUp": { "X-Forwarded-Prefix": "/comfyui" },
    "redirect": { "to": "", "code": 308 },
    "static": { "root": "", "rewrite": "" },
    "raw": ""                     // 非空则整段原样输出
  }],
  "snippets": [{ "id": "ws", "name": "WebSocket 头", "order": 100, "content": "…" }]
}
```

**为什么 `dataDir` 不在 settings 里**：它决定 `state.json` 放在哪，只能来自
插件行配置（`cordis.patch.yml` 的 `config`），从面板里改会把自己搬丢。

**为什么密码只存哈希**：`basic_auth` 的 bcrypt 由 `caddy hash-password` 生成，
`state.json` 里永远是 `$2a$…`；面板不回读密码，留空即不改。

## 4. Caddy 配置：三种粒度

```
caddy/Caddyfile                 主文件（托管模式下由面板生成）
caddy/routes/_managed.caddy     路由渲染结果，按 order 排序
caddy/custom/<id>.caddy         手写片段，面板“自定义片段”管理
```

托管模式下主文件长这样：

```caddyfile
{
	admin 127.0.0.1:2019
	auto_https off
	servers {
		trusted_proxies static private_ranges 127.0.0.1 ::1
	}
}

:8080 {
	import routes/_managed.caddy
	import custom/*.caddy

	handle {
		respond "Not Found" 404
	}
}
```

单条路由（前缀匹配 + 剥前缀 + Basic + CORS）：

```caddyfile
@svc_image {
	path /image*
}
handle @svc_image {
	basic_auth { admin $2a$14$… }
	header {
		Access-Control-Allow-Origin *
		Access-Control-Allow-Headers "Authorization, Content-Type, X-Api-Key"
		Access-Control-Allow-Methods "POST, GET, OPTIONS"
	}
	@svc_image_opt method OPTIONS
	respond @svc_image_opt 204
	reverse_proxy 127.0.0.1:8090
}
```

**为什么用命名 matcher + `uri strip_prefix`**：路径 / Host 条件可以组合；`handle_path` 只接受字面路径，不接受命名 matcher，所以剥前缀改用 `uri strip_prefix`。
匹配器都定义在站点级，避免 Caddy 的内联语法在引号和通配符上踩坑。

**为什么 CORS 的 OPTIONS 匹配器要放在 handle 外面**：Caddy 的 matcher 定义只能
在站点层声明，放进 `handle` 块里是语法错误（单测覆盖了这一点）。

**事务性**：`apply()` = 备份旧文件 → 渲染 → `validate` → 失败还原 → `reload`。
校验失败时面板/工具拿到原始报错，而不是一个半配置的代理。

**手动模式**：写整份 `Caddyfile` 自动切到 manual，结构化路由只保留为记录；
切回 managed 时按 `routes` 重新生成（旧文件先备份为 `*.bak`）。

## 5. 进程监管

- 启动：`spawn(command, { shell: true, cwd, env, windowsHide: true })`，stdout/stderr
  追加到 `logs/<id>.log`，内存保留最近 300 行给面板和工具。
- 停止：`taskkill /PID <pid> /T /F`；没被本插件启动的进程按端口找 PID 再杀，
  这就是“接管”的能力。
- 状态：`netstat -ano -p tcp`（1.2s 缓存）判断端口是否在听；健康检查用
  `fetch` 打 `http://127.0.0.1:<port><healthPath>`，1.5s 超时。
- 归属：`owned=true` 表示本插件启动（插件卸载会一起停）；`owned=false` 但
  `running=true` 表示外部启动、只能观察或停止。
- 启动失败识别：spawn 后等 700ms，进程已经退出就判定失败并返回退出码，
  避免面板显示“启动成功”其实解释器路径写错。

## 6. 启动方式与 Windows 服务

| 方式 | 实现 | 需要管理员 |
|---|---|---|
| 随 DSH | 插件激活时 `startAuto('dsh')` | 否 |
| 登录自启 | `HKCU\…\Run` → `wscript start-all.vbs` → `start-all.cmd` | 否 |
| Windows 服务 | `New-Service` → 自带 `ServiceHost.exe --name <n> --launcher <cmd>` | 是（面板弹 UAC） |

**为什么不是 `cmd.exe /c launcher.cmd`**：服务二进制必须自己跟 SCM 握手，
`cmd.exe` 不会，`Start-Service` 直接报 1053（超时）。所以仓库里带一个几十行的
`assets/ServiceHost.cs`，注册时用系统自带的 `csc.exe` 编译到
`windows-service/ServiceHost.exe`；它完成握手、拉起 launcher、把输出写进
`launcher.service.log`、停止时 `taskkill /T` 杀掉整棵进程树。这样不引入任何
第三方二进制，也不用装 nssm/winsw。

**两种机制互斥**：生成 `start-all.cmd` 前先 `sc query` 每个条目，已被服务接管
的（包括 Caddy）不再写进登录脚本。面板的切换动作 = 停当前进程 → 注册/删除服务
→ 重新生成登录脚本，所以不会出现两套同时启动。

**注册脚本**：安装时写 `windows-service/<id>/{launcher.cmd,install.ps1,uninstall.ps1}`。
`.ps1` 一律带 UTF-8 BOM——Windows PowerShell 5.1 会把无 BOM 的 .ps1 当 ANSI 读，
中文描述会直接把字符串截断成语法错误（这就是第一次点“注册”报的那条）。


## 7. HTTP API（同源）

前缀 `/service-manage`，全部 JSON，只接受回环 + 回环 Host（`isTrustedLocalRequest`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | 面板全量快照 |
| GET | `/logs?id=&lines=` | 日志尾部 |
| GET | `/caddy/file` | 读 Caddyfile |
| POST | `/service/save` `/service/delete` `/service/action` | 增删改 + 启停/日志 |
| POST | `/route/save` `/route/delete` | 路由 + 自动 apply |
| POST | `/snippet/save` `/snippet/delete` | 自定义片段 |
| POST | `/caddy/action` | validate/reload/apply/start/stop/render |
| POST | `/caddy/file` | 写整份 Caddyfile（切手动） |
| POST | `/caddy/mode` | 托管/手动切换 |
| POST | `/settings` `/autostart` `/windows-service` | 设置、自启、服务安装 |

**为什么不用 Typert Remote**：那套需要生成 codegen 产物；同源 HTTP 路由在
`ctx.webServer` 上注册即可，零构建、浏览器可直接 `fetch`，Desktop 之外也够用。

## 8. Agent 工具

| 工具 | 语义 |
|---|---|
| `service_status` | 读全量状态（服务 + Caddy + 路由） |
| `service_control` | start / stop / restart / logs |
| `service_config` | upsert / delete / windows-plan / windows-install / windows-uninstall |
| `proxy_route` | list / upsert / delete，自动校验重载 |
| `caddy_config` | read / write / validate / reload / start / stop / set-mode / snippet-* |

工具描述里写“先读、改完再读”，并说明校验失败会回滚；提示词段落只强调这三条，
不重复参数说明。所有输出都被截断到 12KB。

## 9. 面板

- 侧栏 `sidebar.panellist` 注册 `id: service-manage`，`main` 槽按同 key 渲染。
- 无构建：`window.__ModuleLoader__.load({ id: 'dsh-service-manage', factory })`，
  React 从模块表取。
- 主题只用 `--dsw-alias-*` token；样式作为 `<style>` 元素随组件渲染，卸载即消失。
- 轮询 4s；动作返回的 `state` 直接替换本地快照，减少一次往返。
- 无 iframe：面板是真正的 React 组件，跟随宿主主题和深浅色。

## 10. 风险与后续

| 风险 | 现状 | 后续 |
|---|---|---|
| 进程随插件退出 | 有 `autoStart` 兜底 | 可加“脱离 DSH 常驻”模式 |
| 一个监听端口 | 够用 | settings 支持 `sites[]` 多站点 |
| 面板仅回环 | 安全默认 | 需要远程时加 token |
| 手动模式与路由脱节 | 面板有显式警告 | 可做“从 Caddyfile 反向解析路由”导入 |
| Windows 服务只支持单条命令 | 生成 launcher.cmd | 可接 nssm 做崩溃重启 |

## 11. 验证清单

- `node test/render.test.mjs`：9 条渲染/归一化单测。
- `node --check`：全部入口与库文件。
- 安装后：`/service-manage/state` 返回 JSON；面板五个页签可交互；
  `caddy validate` 通过；改一条路由后 `curl` 验证 New status；工具在会话里可见。
