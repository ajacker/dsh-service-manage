# 本地服务管理（service manager）

一个面板 + 一组 agent 工具，用来管理本机的小服务：启停进程、看日志、把它们
挂到 Caddy 反向代理后面，并决定是否随 DSH 或登录自启。

## 面板

侧栏 **服务** 入口，五个页签：

- **概览**：Caddy 与服务状态、快捷启停、最近状态列表。
- **服务**：每条服务的名称、命令、端口、运行状态、PID、健康检查；启动 / 停止 /
  重启 / 日志 / 编辑 / 注册 Windows 服务 / 删除。
- **反代**：路由列表（路径 → 上游，Basic / CORS / 剥前缀标记），新增或编辑时
  保存即校验并重载。
- **高级**：整份 Caddyfile 编辑、校验、切回托管模式、自定义片段（`custom/*.caddy`）。
- **设置**：监听地址、Caddy 管理接口、可执行文件、随 DSH 启动、开机自启开关，
  以及一键在资源管理器里打开数据目录 / 插件目录 / Caddyfile 所在目录（已有窗口会
  复用并置前；置前被系统拒绝时闪烁任务栏，不会静默留在后面）。

启动、重启返回前会等端口真正开始监听（最长 25 秒），健康检查只作为展示信息：
一个服务的 `/health` 可能因为它的依赖没起来而报错，那不代表它自己没启动成功。

切换自启方式要等 UAC 和 SCM，可能持续十几秒。面板在这类操作进行时会盖一层
半透明遮罩（约 200ms 后才出现，短操作不会闪）：期间状态轮询暂停、下拉框禁用、
重复点击被吞掉，所以不会出现“连点几次切换、最后留下一个不一致的状态”。
遮罩只在面板区域内，文案说明正在做什么、为什么要等。

## 自启方式（两种，可切换）

| | 登录脚本 | Windows 服务 |
|---|---|---|
| 触发 | 用户登录后 | 开机即启，无需登录 |
| 权限 | 不需要管理员 | 需要管理员，面板会弹 UAC |
| 位置 | `HKCU\…\Run\DSHServiceManage` → `autostart\start-all.vbs` | `services.msc`：`DSH-ServiceManage-caddy`、`DSH-ServiceManage-<id>` |
| 运行身份 | 当前用户 | LocalSystem |

服务行上的下拉框和设置页的「Caddy 自启方式」都能切换。切换会先停掉当前进程，
再由另一种方式接管，并重新生成登录脚本，两个机制不会同时启动同一个条目。

> Windows 不允许 `cmd.exe /c xxx.cmd` 当服务（SCM 握手超时，1053）。插件自带
> `assets/ServiceHost.cs`，注册时用系统自带的 csc 编译成 `ServiceHost.exe`：
> 完成 SCM 握手、拉起 launcher、输出写 `launcher.service.log`、停止时 `taskkill /T`。

## 服务定义

| 字段 | 说明 |
|---|---|
| 名称 / 说明 | 面板展示用 |
| 工作目录 | 进程 cwd，支持 `%ENV%` |
| 启动命令 | 经 `cmd.exe` 执行；路径带空格用引号 |
| 端口 | 用于状态判断、冲突检测、代理上游 |
| 健康检查路径 | 可选，例如 `/health` |
| 环境变量 | 每行 `KEY=VALUE` |
| 启动方式 | 手动 / 随 DSH / 登录自启 |
| 管理方式 | 由面板启停，或只观察外部进程 |

## 反向代理

托管模式（默认）下 Caddyfile 由面板生成：

- `routes/_managed.caddy`：结构化路由，按“顺序”渲染；
- `custom/*.caddy`：手写片段，面板“自定义片段”维护；
- 末尾 `handle { respond "Not Found" 404 }` 兜底。

任何改动都会 `caddy validate` 后再 `caddy reload`；校验失败会把文件还原，
并在面板或工具结果里给出 Caddy 的原始报错。

手动模式：直接编辑整份 Caddyfile，适合结构化模型表达不了的配置。此模式下
结构化路由只做记录、不参与渲染；切回托管模式会重新生成。

## 让 agent 代劳

五个工具：

| 工具 | 用途 |
|---|---|
| `service_status` | 读取全部状态 |
| `service_control` | 启停/重启/日志 |
| `service_config` | 增删改服务、Windows 服务安装 |
| `proxy_route` | 路由增删改 |
| `caddy_config` | 整份 Caddyfile 读写、校验、重载、模式切换 |

例：`把 image-api 加进来，工作目录 D:\…\image-api，命令 "F:\Miniconda3\python.exe" main.py，端口 8090，随 DSH 启动；再把 /image 反代到它`。

## 已知限制

- Windows 优先：进程控制和自启依赖 `taskkill`、`netstat`、注册表。
- 插件启动的进程随插件卸载而结束；长期常驻请用“随 DSH 启动”或注册为 Windows 服务。
- 注册 Windows 服务需要管理员权限；无权限时生成安装脚本。
- 面板 API 只接受本机回环请求；一个安装只有一份反代监听。
- 界面文案目前为中文。
