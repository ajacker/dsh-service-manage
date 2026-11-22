/**
 * dsh-service-manage — browser half.
 *
 * Registers one sidebar entry and one main panel. The panel talks to the host
 * half over the same-origin `/service-manage` route, so it needs no storage of
 * its own and re-reads the truth after every action.
 */
window.__ModuleLoader__.load({
  id: 'dsh-service-manage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/service-manage'
    const POLL_MS = 4000

    /* ───────────────────────── 基础控件 ───────────────────────── */

    function Pill({ tone, children }) {
      return h('span', { className: 'sm-pill', 'data-tone': tone ?? 'idle' }, children)
    }

    function Btn({ onClick, children, kind, disabled, title }) {
      return h('button', {
        type: 'button',
        className: 'sm-btn',
        'data-kind': kind ?? 'ghost',
        disabled: Boolean(disabled),
        title,
        onClick,
      }, children)
    }

    function Field({ label, hint, children, wide }) {
      return h('label', { className: 'sm-field', 'data-wide': wide ? 'true' : undefined },
        h('span', { className: 'sm-field-label' }, label),
        children,
        hint ? h('span', { className: 'sm-field-hint' }, hint) : null,
      )
    }

    function Modal({ title, onClose, children, footer, wide }) {
      useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'sm-modal-mask', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'sm-modal', 'data-wide': wide ? 'true' : undefined, role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'sm-modal-head' },
            h('strong', null, title),
            h('button', { type: 'button', className: 'sm-x', 'aria-label': '关闭', onClick: onClose }, '×'),
          ),
          h('div', { className: 'sm-modal-body' }, children),
          footer ? h('div', { className: 'sm-modal-foot' }, footer) : null,
        ),
      )
    }

    /* ───────────────────────── 网络 ───────────────────────── */

    async function call(path, body) {
      const init = body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          }
      const response = await fetch(`${API}${path}`, init)
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      const payload = await response.json()
      if (!payload.ok) throw new Error(payload.error || '请求失败')
      return payload.data
    }

    /* ───────────────────────── 格式化 ───────────────────────── */

    function uptime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const total = Math.floor(ms / 1000)
      const day = Math.floor(total / 86400)
      const hour = Math.floor((total % 86400) / 3600)
      const minute = Math.floor((total % 3600) / 60)
      if (day > 0) return `${day}天${hour}小时`
      if (hour > 0) return `${hour}小时${minute}分`
      return `${minute}分`
    }

    function autoLabel(value) {
      return value === 'boot' ? '开机自启' : value === 'dsh' ? '随 DSH' : '手动'
    }

    /**
     * How one service starts today: an installed Windows service wins over the
     * login launcher, which in turn only covers autoStart "boot".
     * @param {Record<string, any>} service - snapshot row.
     * @returns {'service' | 'script' | 'manual'} the effective mechanism.
     */
    function bootOf(service) {
      if (service.windowsService?.exists) return 'service'
      if (service.autoStart === 'boot') return 'script'
      return 'manual'
    }

    function bootLabel(service) {
      const mode = bootOf(service)
      return mode === 'service' ? 'Windows 服务' : mode === 'script' ? '登录自启' : autoLabel(service.autoStart)
    }

    async function runSeries(items, fn) {
      const results = []
      for (const item of items) results.push(await fn(item))
      return results
    }

    /* ───────────────────────── 服务表单 ───────────────────────── */

    function emptyService() {
      return {
        id: '', name: '', description: '', cwd: '', command: '',
        port: '', healthPath: '', autoStart: 'none', manage: 'process', env: '',
      }
    }

    function toServiceDraft(service) {
      return {
        id: service.id,
        name: service.name,
        description: service.description ?? '',
        cwd: service.cwd ?? '',
        command: service.command ?? '',
        port: service.port ? String(service.port) : '',
        healthPath: service.healthPath ?? '',
        autoStart: service.autoStart ?? 'none',
        manage: service.manage ?? 'process',
        env: Object.entries(service.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
      }
    }

    function parseEnv(text) {
      const env = {}
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue
        const index = trimmed.indexOf('=')
        if (index <= 0) continue
        env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1)
      }
      return env
    }

    function ServiceEditor({ initial, onClose, onSaved, notify }) {
      const [draft, setDraft] = useState(initial ?? emptyService())
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const update = (key, value) => setDraft(prev => ({ ...prev, [key]: value }))

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const data = await call('/service/save', {
            service: {
              id: draft.id || undefined,
              name: draft.name || draft.id,
              description: draft.description,
              cwd: draft.cwd,
              command: draft.command,
              port: draft.port ? Number(draft.port) : 0,
              healthPath: draft.healthPath,
              autoStart: draft.autoStart,
              manage: draft.manage,
              env: parseEnv(draft.env),
            },
          })
          notify(`已保存 ${data.service.name}`)
          onSaved(data.state)
          onClose()
        } catch (err) {
          setError(String(err.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: initial ? `编辑服务 · ${initial.name}` : '新增服务',
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
        ),
      },
        error ? h('div', { className: 'sm-error' }, error) : null,
        h('div', { className: 'sm-grid' },
          h(Field, { label: '名称' }, h('input', { className: 'sm-input', value: draft.name, onChange: e => update('name', e.target.value), placeholder: '生图 API' })),
          h(Field, { label: 'ID', hint: '留空则按名称生成；已有服务不可改' },
            h('input', { className: 'sm-input', value: draft.id, disabled: Boolean(initial), onChange: e => update('id', e.target.value), placeholder: 'image-api' })),
          h(Field, { label: '说明', wide: true },
            h('input', { className: 'sm-input', value: draft.description, onChange: e => update('description', e.target.value), placeholder: 'ComfyUI 生图接口与前端' })),
          h(Field, { label: '工作目录', wide: true, hint: '服务进程的 cwd，支持 %ENV%' },
            h('input', { className: 'sm-input', value: draft.cwd, onChange: e => update('cwd', e.target.value), placeholder: 'D:\\services\\image-api' })),
          h(Field, { label: '启动命令', wide: true, hint: '经 cmd.exe 执行，路径带空格时用引号包起来' },
            h('input', { className: 'sm-input sm-mono', value: draft.command, onChange: e => update('command', e.target.value), placeholder: '"F:\\Miniconda3\\python.exe" main.py' })),
          h(Field, { label: '端口' }, h('input', { className: 'sm-input', value: draft.port, onChange: e => update('port', e.target.value), placeholder: '8090', inputMode: 'numeric' })),
          h(Field, { label: '健康检查路径', hint: '可选，例如 /health' },
            h('input', { className: 'sm-input sm-mono', value: draft.healthPath, onChange: e => update('healthPath', e.target.value), placeholder: '/health' })),
          h(Field, { label: '启动方式' },
            h('select', { className: 'sm-input', value: draft.autoStart, onChange: e => update('autoStart', e.target.value) },
              h('option', { value: 'none' }, '手动'),
              h('option', { value: 'dsh' }, '随 DSH 启动'),
              h('option', { value: 'boot' }, '开机自启（登录时）'),
            )),
          h(Field, { label: '管理方式' },
            h('select', { className: 'sm-input', value: draft.manage, onChange: e => update('manage', e.target.value) },
              h('option', { value: 'process' }, '由面板启停'),
              h('option', { value: 'external' }, '只观察（外部启动）'),
            )),
          h(Field, { label: '环境变量', wide: true, hint: '每行 KEY=VALUE' },
            h('textarea', { className: 'sm-input sm-mono', rows: 3, value: draft.env, onChange: e => update('env', e.target.value), placeholder: 'PORT=8090' })),
        ),
      )
    }

    /* ───────────────────────── 路由表单 ───────────────────────── */

    function emptyRoute() {
      return {
        id: '', name: '', path: '/', exact: false, host: '', kind: 'proxy',
        upstream: '', stripPrefix: false, cors: false, to: '', code: 308,
        root: '', rewrite: '', order: 100, enabled: true,
        authType: 'none', authUser: '', authPassword: '',
      }
    }

    function toRouteDraft(route) {
      return {
        id: route.id,
        name: route.name,
        path: route.match?.path ?? '/',
        exact: Boolean(route.match?.exact),
        host: route.match?.host ?? '',
        kind: route.kind,
        upstream: route.upstream ?? '',
        stripPrefix: Boolean(route.stripPrefix),
        cors: Boolean(route.cors),
        to: route.redirect?.to ?? '',
        code: route.redirect?.code ?? 308,
        root: route.static?.root ?? '',
        rewrite: route.static?.rewrite ?? '',
        order: route.order ?? 100,
        enabled: route.enabled !== false,
        authType: route.auth?.type ?? 'none',
        authUser: route.auth?.user ?? '',
        authPassword: '',
      }
    }

    function RouteEditor({ initial, manualMode, onClose, onSaved, notify }) {
      const [draft, setDraft] = useState(initial ?? emptyRoute())
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const update = (key, value) => setDraft(prev => ({ ...prev, [key]: value }))

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const data = await call('/route/save', {
            route: {
              id: draft.id || undefined,
              name: draft.name || draft.path,
              path: draft.path,
              exact: draft.exact,
              host: draft.host,
              kind: draft.kind,
              upstream: draft.upstream,
              stripPrefix: draft.stripPrefix,
              cors: draft.cors,
              to: draft.to,
              code: Number(draft.code) || 308,
              root: draft.root,
              rewrite: draft.rewrite,
              order: Number(draft.order) || 100,
              enabled: draft.enabled,
              auth: {
                type: draft.authType,
                user: draft.authUser,
                password: draft.authPassword,
              },
            },
          })
          if (data.applied && !data.applied.ok) {
            setError(`Caddy 校验/重载失败：${data.applied.output}`)
            onSaved(data.state)
            return
          }
          notify(`已保存路由 ${data.route.path}`)
          onSaved(data.state)
          onClose()
        } catch (err) {
          setError(String(err.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: initial ? `编辑路由 · ${initial.name}` : '新增反代路由',
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存并重载'),
        ),
      },
        manualMode ? h('div', { className: 'sm-warn' }, '当前 Caddyfile 处于手动模式：保存的路由会被记录，但不会渲染。切回托管模式后生效。') : null,
        error ? h('div', { className: 'sm-error' }, error) : null,
        h('div', { className: 'sm-grid' },
          h(Field, { label: '名称' }, h('input', { className: 'sm-input', value: draft.name, onChange: e => update('name', e.target.value), placeholder: '生图前端' })),
          h(Field, { label: '匹配路径', hint: '默认前缀匹配，例如 /image 也匹配 /image/a.js' },
            h('input', { className: 'sm-input sm-mono', value: draft.path, onChange: e => update('path', e.target.value), placeholder: '/image' })),
          h(Field, { label: '精确匹配' },
            h('select', { className: 'sm-input', value: draft.exact ? 'yes' : 'no', onChange: e => update('exact', e.target.value === 'yes') },
              h('option', { value: 'no' }, '否（前缀）'),
              h('option', { value: 'yes' }, '是（只匹配该路径）'),
            )),
          h(Field, { label: 'Host（可选）' },
            h('input', { className: 'sm-input', value: draft.host, onChange: e => update('host', e.target.value), placeholder: 'pc.example.com' })),
          h(Field, { label: '类型' },
            h('select', { className: 'sm-input', value: draft.kind, onChange: e => update('kind', e.target.value) },
              h('option', { value: 'proxy' }, '反向代理'),
              h('option', { value: 'redirect' }, '重定向'),
              h('option', { value: 'static' }, '静态文件'),
            )),
          h(Field, { label: '顺序', hint: '小的先匹配' },
            h('input', { className: 'sm-input', value: draft.order, onChange: e => update('order', e.target.value), inputMode: 'numeric' })),
          draft.kind === 'proxy' ? h(Field, { label: '上游地址', wide: true, hint: 'host:port，不带协议' },
            h('input', { className: 'sm-input sm-mono', value: draft.upstream, onChange: e => update('upstream', e.target.value), placeholder: '127.0.0.1:8090' })) : null,
          draft.kind === 'redirect' ? h(React.Fragment, null,
            h(Field, { label: '目标地址' }, h('input', { className: 'sm-input sm-mono', value: draft.to, onChange: e => update('to', e.target.value), placeholder: '/image/' })),
            h(Field, { label: '状态码' }, h('input', { className: 'sm-input', value: draft.code, onChange: e => update('code', e.target.value), inputMode: 'numeric' })),
          ) : null,
          draft.kind === 'static' ? h(React.Fragment, null,
            h(Field, { label: '根目录', wide: true }, h('input', { className: 'sm-input sm-mono', value: draft.root, onChange: e => update('root', e.target.value), placeholder: 'D:\\site' })),
            h(Field, { label: '重写目标', wide: true }, h('input', { className: 'sm-input sm-mono', value: draft.rewrite, onChange: e => update('rewrite', e.target.value), placeholder: '/index.html' })),
          ) : null,
          h(Field, { label: '处理前缀' },
            h('select', { className: 'sm-input', value: draft.stripPrefix ? 'yes' : 'no', onChange: e => update('stripPrefix', e.target.value === 'yes') },
              h('option', { value: 'no' }, '保留路径'),
              h('option', { value: 'yes' }, '剥离前缀'),
            )),
          h(Field, { label: 'CORS' },
            h('select', { className: 'sm-input', value: draft.cors ? 'yes' : 'no', onChange: e => update('cors', e.target.value === 'yes') },
              h('option', { value: 'no' }, '关闭'),
              h('option', { value: 'yes' }, '开启（含 OPTIONS 204）'),
            )),
          h(Field, { label: '认证' },
            h('select', { className: 'sm-input', value: draft.authType, onChange: e => update('authType', e.target.value) },
              h('option', { value: 'none' }, '无'),
              h('option', { value: 'basic' }, 'Basic'),
            )),
          h(Field, { label: '启用' },
            h('select', { className: 'sm-input', value: draft.enabled ? 'yes' : 'no', onChange: e => update('enabled', e.target.value === 'yes') },
              h('option', { value: 'yes' }, '启用'),
              h('option', { value: 'no' }, '停用'),
            )),
          draft.authType === 'basic' ? h(React.Fragment, null,
            h(Field, { label: '用户名' }, h('input', { className: 'sm-input', value: draft.authUser, onChange: e => update('authUser', e.target.value), placeholder: 'admin' })),
            h(Field, { label: '密码', hint: initial && initial.auth?.type === 'basic' ? '留空表示不改' : '只保存 bcrypt 哈希' },
              h('input', { className: 'sm-input', type: 'password', value: draft.authPassword, onChange: e => update('authPassword', e.target.value) })),
          ) : null,
        ),
      )
    }

    /* ───────────────────────── 日志弹窗 ───────────────────────── */

    function LogsModal({ service, onClose }) {
      const [lines, setLines] = useState([])
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        setBusy(true)
        try {
          const data = await call('/service/action', { id: service.id, action: 'logs', lines: 300 })
          setLines(data.lines ?? [])
        } catch (err) {
          setLines([String(err.message ?? err)])
        } finally {
          setBusy(false)
        }
      }, [service.id])
      useEffect(() => { void load() }, [load])
      return h(Modal, {
        title: `日志 · ${service.name}`,
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: load, disabled: busy }, busy ? '读取中…' : '刷新'),
          h(Btn, { onClick: onClose }, '关闭'),
        ),
      },
        h('pre', { className: 'sm-log' }, lines.length > 0 ? lines.join('\n') : '（暂无日志）'),
      )
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    function Panel(props = {}) {
      const [state, setState] = useState(props.initialState ?? null)
      const [tab, setTab] = useState(props.initialTab ?? 'overview')
      const [error, setError] = useState('')
      const [toast, setToast] = useState('')
      const [busy, setBusy] = useState(false)
      const [editor, setEditor] = useState(null)
      const [logsFor, setLogsFor] = useState(null)
      const busyRef = useRef(false)

      const notify = useCallback(message => {
        setToast(message)
        window.setTimeout(() => setToast(current => (current === message ? '' : current)), 2600)
      }, [])

      const refresh = useCallback(async (silent) => {
        if (busyRef.current) return
        busyRef.current = true
        try {
          const next = await call('/state')
          setState(next)
          if (!silent) setError('')
        } catch (err) {
          if (!silent) setError(`无法读取服务状态：${String(err.message ?? err)}`)
        } finally {
          busyRef.current = false
        }
      }, [])

      useEffect(() => {
        void refresh(true)
        const timer = window.setInterval(() => { void refresh(true) }, POLL_MS)
        return () => window.clearInterval(timer)
      }, [refresh])

      const act = useCallback(async (path, body, successText) => {
        setBusy(true)
        setError('')
        try {
          const data = await call(path, body)
          if (data?.state) setState(data.state)
          if (successText) notify(successText)
          return data
        } catch (err) {
          setError(String(err.message ?? err))
          return undefined
        } finally {
          setBusy(false)
        }
      }, [notify])

      const setBoot = useCallback(async (service, mode) => {
        if (mode === 'manual') {
          if (service.windowsService?.exists) await act('/service/boot-mode', { id: service.id, mode: 'script' })
          await act('/service/save', { service: { id: service.id, autoStart: 'none' } }, '已改为手动启动')
          return
        }
        await act('/service/save', { service: { id: service.id, autoStart: 'boot' } })
        const data = await act('/service/boot-mode', { id: service.id, mode })
        if (data?.result?.ok === false) {
          setError(`${data.result.output}\n\n以管理员身份执行：\n${data.result.plan?.command ?? ''}`)
          return
        }
        notify(mode === 'service' ? `已注册为 Windows 服务：${service.name}` : `已改为登录脚本自启：${service.name}`)
      }, [act, notify])

      if (!state) {
        return h('div', { className: 'sm-root' },
          h('style', null, CSS),
          h('div', { className: 'sm-empty' }, error || '正在读取服务状态…'),
        )
      }

      const services = state.services ?? []
      const routes = state.routes ?? []
      const snippets = state.snippets ?? []
      const runningCount = services.filter(item => item.running).length

      const tabs = [
        ['overview', '概览'],
        ['services', `服务 ${runningCount}/${services.length}`],
        ['routes', `反代 ${routes.length}`],
        ['advanced', '高级'],
        ['settings', '设置'],
      ]

      return h('div', { className: 'sm-root' },
        h('style', null, CSS),
        h('div', { className: 'sm-head' },
          h('div', { className: 'sm-title-row' },
            h('strong', { className: 'sm-title' }, '本地服务管理'),
            h('div', { className: 'sm-pills' },
              h(Pill, { tone: state.caddy.running ? 'ok' : 'idle' }, `Caddy ${state.caddy.running ? '运行中' : '未运行'}`),
              h(Pill, { tone: services.some(item => item.running) ? 'ok' : 'idle' }, `服务 ${runningCount}/${services.length}`),
              h(Pill, { tone: state.mode === 'managed' ? 'ok' : 'warn' }, state.mode === 'managed' ? '托管模式' : '手动模式'),
              state.autostart ? h(Pill, { tone: 'ok' }, '开机自启') : null,
            ),
            h('div', { className: 'sm-spacer' }),
            h(Btn, { onClick: () => refresh(false), disabled: busy }, '刷新'),
          ),
          h('div', { className: 'sm-tabs' },
            tabs.map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              className: 'sm-tab',
              'data-active': tab === id ? 'true' : 'false',
              onClick: () => setTab(id),
            }, label)),
          ),
        ),
        error ? h('div', { className: 'sm-error sm-banner' }, error) : null,
        h('div', { className: 'sm-body' },
          tab === 'overview' ? renderOverview() : null,
          tab === 'services' ? renderServices() : null,
          tab === 'routes' ? renderRoutes() : null,
          tab === 'advanced' ? renderAdvanced() : null,
          tab === 'settings' ? renderSettings() : null,
        ),
        toast ? h('div', { className: 'sm-toast' }, toast) : null,
        editor ? (editor.type === 'service'
          ? h(ServiceEditor, {
              initial: editor.value,
              onClose: () => setEditor(null),
              onSaved: setState,
              notify,
            })
          : h(RouteEditor, {
              initial: editor.value,
              manualMode: state.mode === 'manual',
              onClose: () => setEditor(null),
              onSaved: setState,
              notify,
            })) : null,
        logsFor ? h(LogsModal, { service: logsFor, onClose: () => setLogsFor(null) }) : null,
      )

      /* ── 概览 ── */
      function renderOverview() {
        return h('div', { className: 'sm-stack' },
          h('div', { className: 'sm-cards' },
            h('div', { className: 'sm-card' },
              h('div', { className: 'sm-card-title' }, '反向代理'),
              h('div', { className: 'sm-card-value' }, state.caddy.running ? '运行中' : '未运行'),
              h('div', { className: 'sm-muted' }, `监听 ${state.settings.proxyListen} · 管理接口 ${state.caddy.admin}`),
              h('div', { className: 'sm-row-actions' },
                state.caddy.running
                  ? h(Btn, { onClick: () => act('/caddy/action', { action: 'reload' }, 'Caddy 已重载') }, '重载')
                  : h(Btn, { kind: 'primary', onClick: () => act('/caddy/action', { action: 'start' }, 'Caddy 已启动') }, '启动'),
                h(Btn, { onClick: () => act('/caddy/action', { action: 'validate' }).then(data => {
                  if (data) notify(data.result.ok ? '配置有效' : '配置有误')
                }) }, '校验'),
                state.caddy.running ? h(Btn, { kind: 'danger', onClick: () => act('/caddy/action', { action: 'stop' }, 'Caddy 已停止') }, '停止') : null,
              ),
            ),
            h('div', { className: 'sm-card' },
              h('div', { className: 'sm-card-title' }, '服务'),
              h('div', { className: 'sm-card-value' }, `${runningCount} / ${services.length}`),
              h('div', { className: 'sm-muted' }, `随 DSH 启动 ${services.filter(item => item.autoStart === 'dsh').length} 个 · 开机自启 ${services.filter(item => item.autoStart === 'boot').length} 个`),
              h('div', { className: 'sm-row-actions' },
                h(Btn, { onClick: () => refresh(false) }, '刷新状态'),
              ),
            ),
            h('div', { className: 'sm-card' },
              h('div', { className: 'sm-card-title' }, '反代路由'),
              h('div', { className: 'sm-card-value' }, String(routes.filter(item => item.enabled).length)),
              h('div', { className: 'sm-muted' }, `共 ${routes.length} 条 · Caddyfile ${state.mode === 'managed' ? '由面板生成' : '由手工维护'}`),
              h('div', { className: 'sm-row-actions' },
                h(Btn, { onClick: () => setTab('routes') }, '管理路由'),
                h(Btn, { onClick: () => setTab('advanced') }, '编辑 Caddyfile'),
              ),
            ),
          ),
          h('div', { className: 'sm-card' },
            h('div', { className: 'sm-card-title' }, '快捷操作'),
            h('div', { className: 'sm-row-actions' },
              h(Btn, { kind: 'primary', onClick: async () => {
                await runSeries(services.filter(item => item.manage !== 'external'), item => act('/service/action', { id: item.id, action: 'start' }))
                notify('已启动全部服务')
              }, disabled: busy }, '启动全部'),
              h(Btn, { onClick: async () => {
                await runSeries(services, item => act('/service/action', { id: item.id, action: 'stop' }))
                notify('已停止全部服务')
              }, disabled: busy }, '停止全部'),
              h(Btn, { onClick: () => act('/caddy/action', { action: 'apply' }, '已重新生成并重载') }, '重新生成 Caddyfile'),
            ),
            h('div', { className: 'sm-muted sm-mt' }, `数据目录 ${state.dataDir}`),
          ),
          h('div', { className: 'sm-card' },
            h('div', { className: 'sm-card-title' }, '最近状态'),
            h('div', { className: 'sm-table' },
              services.length === 0
                ? h('div', { className: 'sm-empty' }, '还没有服务。切到“服务”页新增一个，或让 agent 用 service_config 创建。')
                : services.map(item => h('div', { key: item.id, className: 'sm-tr' },
                    h('span', { className: 'sm-td sm-grow' }, item.name, h('span', { className: 'sm-muted' }, item.port ? ` :${item.port}` : '')),
                    h(Pill, { tone: item.running ? 'ok' : 'idle' }, item.running ? `运行中 · ${uptime(item.uptimeMs)}` : '已停止'),
                    h('span', { className: 'sm-td sm-mono' }, item.command),
                  )),
            ),
          ),
        )
      }

      /* ── 服务 ── */
      function renderServices() {
        return h('div', { className: 'sm-stack' },
          h('div', { className: 'sm-toolbar' },
            h('strong', null, '服务'),
            h('span', { className: 'sm-muted' }, `${runningCount} 个运行中`),
            h('div', { className: 'sm-spacer' }),
            h(Btn, { kind: 'primary', onClick: () => setEditor({ type: 'service', value: null }) }, '新增服务'),
          ),
          services.length === 0
            ? h('div', { className: 'sm-card sm-empty' }, '还没有服务。新增时填写工作目录和启动命令即可。')
            : services.map(service => h('div', { key: service.id, className: 'sm-card sm-service' },
                h('div', { className: 'sm-service-head' },
                  h('div', { className: 'sm-service-title' },
                    h('strong', null, service.name),
                    h(Pill, { tone: service.running ? 'ok' : 'idle' }, service.running ? '运行中' : '已停止'),
                    service.pid ? h('span', { className: 'sm-muted' }, `PID ${service.pid}`) : null,
                    service.port ? h('span', { className: 'sm-muted' }, `:${service.port}`) : null,
                    service.running && service.health
                      ? h(Pill, { tone: service.health.ok ? 'ok' : 'warn' }, service.health.ok ? `健康 ${service.health.status}` : '健康检查失败')
                      : null,
                    h(Pill, { tone: bootOf(service) === 'service' ? 'ok' : 'plain' }, bootLabel(service)),
                    service.manage === 'external' ? h(Pill, { tone: 'plain' }, '外部') : null,
                  ),
                  h('div', { className: 'sm-row-actions' },
                    service.manage === 'external'
                      ? null
                      : h('select', {
                          className: 'sm-input sm-mode',
                          title: '开机自启方式',
                          value: bootOf(service),
                          onChange: event => { void setBoot(service, event.target.value) },
                        },
                          h('option', { value: 'manual' }, '手动'),
                          h('option', { value: 'script' }, '登录脚本'),
                          h('option', { value: 'service' }, 'Windows 服务'),
                        ),
                    service.manage === 'external' || service.running
                      ? null
                      : h(Btn, { kind: 'primary', onClick: () => act('/service/action', { id: service.id, action: 'start' }, `已启动 ${service.name}`) }, '启动'),
                    service.running
                      ? h(Btn, { onClick: () => act('/service/action', { id: service.id, action: 'stop' }, `已停止 ${service.name}`) }, '停止')
                      : null,
                    h(Btn, { onClick: () => act('/service/action', { id: service.id, action: 'restart' }, `已重启 ${service.name}`) }, '重启'),
                    h(Btn, { onClick: () => setLogsFor(service) }, '日志'),
                    h(Btn, { onClick: () => setEditor({ type: 'service', value: toServiceDraft(service) }) }, '编辑'),
                    h(Btn, { kind: 'danger', onClick: () => {
                      if (!window.confirm(`删除服务 ${service.name}？进程会被停止。`)) return
                      void act('/service/delete', { id: service.id }, '已删除')
                    } }, '删除'),
                  ),
                ),
                service.description ? h('div', { className: 'sm-muted sm-desc' }, service.description) : null,
                h('div', { className: 'sm-kv' }, h('span', null, '命令'), h('code', { className: 'sm-wrap' }, service.command)),
                service.cwd ? h('div', { className: 'sm-kv' }, h('span', null, '目录'), h('code', { className: 'sm-wrap' }, service.cwd)) : null,
                service.lastExit && !service.running
                  ? h('div', { className: 'sm-muted' }, `上次退出码 ${service.lastExit.code} · ${service.lastExit.at}`)
                  : null,
              )),
        )
      }

      /* ── 反代 ── */
      function renderRoutes() {
        return h('div', { className: 'sm-stack' },
          state.mode === 'manual'
            ? h('div', { className: 'sm-warn' }, 'Caddyfile 处于手动模式。这里的路由只做记录，不会生效；在“高级”页切回托管模式后重新渲染。')
            : null,
          h('div', { className: 'sm-toolbar' },
            h('strong', null, '反向代理路由'),
            h('span', { className: 'sm-muted' }, `监听 ${state.settings.proxyListen}`),
            h('div', { className: 'sm-spacer' }),
            h(Btn, { onClick: () => act('/caddy/action', { action: 'apply' }, '已重新渲染并重载') }, '重新渲染'),
            h(Btn, { kind: 'primary', onClick: () => setEditor({ type: 'route', value: null }) }, '新增路由'),
          ),
          routes.length === 0
            ? h('div', { className: 'sm-card sm-empty' }, '还没有路由。新增一条把 /image 指到 127.0.0.1:8090 试试。')
            : h('div', { className: 'sm-table sm-table-card' },
                routes.map(route => h('div', { key: route.id, className: 'sm-route' },
                  h('div', { className: 'sm-route-main' },
                    h('div', { className: 'sm-route-title' },
                      h('strong', { className: 'sm-mono' }, route.match?.path),
                      route.match?.exact ? h(Pill, { tone: 'plain' }, '精确') : null,
                      route.stripPrefix ? h(Pill, { tone: 'plain' }, '剥离前缀') : null,
                      route.cors ? h(Pill, { tone: 'plain' }, 'CORS') : null,
                      route.auth?.type === 'basic' ? h(Pill, { tone: 'warn' }, 'Basic') : null,
                      route.enabled === false ? h(Pill, { tone: 'idle' }, '已停用') : null,
                      route.match?.host ? h('span', { className: 'sm-muted' }, route.match.host) : null,
                    ),
                    h('div', { className: 'sm-muted' },
                      route.name,
                      ' · ',
                      route.kind === 'proxy' ? `→ ${route.upstream}` : route.kind === 'redirect' ? `→ ${route.redirect?.to} (${route.redirect?.code})` : `→ ${route.static?.root}`,
                    ),
                  ),
                  h('div', { className: 'sm-row-actions' },
                    h(Btn, { onClick: () => setEditor({ type: 'route', value: toRouteDraft(route) }) }, '编辑'),
                    h(Btn, { kind: 'danger', onClick: () => {
                      if (!window.confirm(`删除路由 ${route.match?.path}？`)) return
                      void act('/route/delete', { id: route.id }, '已删除路由')
                    } }, '删除'),
                  ),
                )),
              ),
        )
      }

      /* ── 高级 ── */
      function renderAdvanced() {
        return h(AdvancedTab, {
          state,
          act,
          notify,
          refresh,
          setState,
        })
      }

      /* ── 设置 ── */
      function renderSettings() {
        return h(SettingsTab, { state, act, notify, refresh })
      }
    }

    /* ───────────────────────── 高级页 ───────────────────────── */

    function AdvancedTab({ state, act, notify, refresh, setState }) {
      const [content, setContent] = useState('')
      const [loaded, setLoaded] = useState(false)
      const [busy, setBusy] = useState(false)
      const [output, setOutput] = useState('')
      const [snippet, setSnippet] = useState({ id: '', name: '', content: '' })

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const data = await call('/caddy/file')
            if (!alive) return
            setContent(data.content)
            setLoaded(true)
          } catch (err) {
            setOutput(String(err.message ?? err))
          }
        })()
        return () => { alive = false }
      }, [state.mode, state.caddyfile])

      const saveFile = async () => {
        setBusy(true)
        setOutput('')
        try {
          const data = await call('/caddy/file', { content })
          if (data.state) setState(data.state)
          setOutput(data.result.ok ? '已保存并重载。' : `保存失败：${data.result.output}`)
          if (data.result.ok) notify('Caddyfile 已保存')
        } catch (err) {
          setOutput(String(err.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      const saveSnippet = async () => {
        setBusy(true)
        setOutput('')
        try {
          const data = await call('/snippet/save', { snippet })
          if (data.state) setState(data.state)
          if (data.applied && !data.applied.ok) setOutput(`校验失败：${data.applied.output}`)
          else notify('片段已保存并生效')
          setSnippet({ id: '', name: '', content: '' })
        } catch (err) {
          setOutput(String(err.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'sm-stack' },
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-toolbar' },
            h('strong', null, 'Caddyfile'),
            h('span', { className: 'sm-muted sm-mono' }, state.caddyfile),
            h('div', { className: 'sm-spacer' }),
            state.mode === 'manual'
              ? h(Btn, { onClick: () => act('/caddy/mode', { mode: 'managed' }, '已切回托管模式') }, '切回托管模式')
              : h(Btn, { onClick: () => act('/caddy/mode', { mode: 'manual' }, '已切换到手动模式') }, '切换为手动模式'),
            h(Btn, { onClick: () => act('/caddy/action', { action: 'validate' }).then(data => {
              if (data) setOutput(data.result.ok ? `配置有效：\n${data.result.output}` : data.result.output)
            }) }, '校验'),
            h(Btn, { kind: 'primary', onClick: saveFile, disabled: busy || !loaded }, busy ? '保存中…' : '保存并重载'),
          ),
          h('p', { className: 'sm-muted' }, '手动编辑会切换到手动模式：面板生成的路由与片段不再覆盖这个文件。建议先备份，或用下面的“自定义片段”保留可回滚的空间。'),
          h('textarea', {
            className: 'sm-input sm-mono sm-code',
            rows: 18,
            spellCheck: false,
            value: content,
            onChange: event => setContent(event.target.value),
          }),
        ),
        output ? h('pre', { className: 'sm-log sm-log-sm' }, output) : null,
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-toolbar' }, h('strong', null, '自定义片段'), h('span', { className: 'sm-muted' }, '写入 custom/*.caddy，托管模式下自动 import')),
          (state.snippets ?? []).length === 0
            ? h('div', { className: 'sm-muted' }, '还没有片段。')
            : h('div', { className: 'sm-table' },
                (state.snippets ?? []).map(item => h('div', { key: item.id, className: 'sm-tr' },
                  h('span', { className: 'sm-td sm-grow' }, h('strong', null, item.name), ' ', h('span', { className: 'sm-muted sm-mono' }, item.id)),
                  h(Btn, { onClick: () => setSnippet({ id: item.id, name: item.name, content: item.content }) }, '编辑'),
                  h(Btn, { kind: 'danger', onClick: () => act('/snippet/delete', { id: item.id }, '已删除片段') }, '删除'),
                )),
              ),
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-toolbar' }, h('strong', null, snippet.id ? `编辑片段 ${snippet.id}` : '新增片段')),
          h('div', { className: 'sm-grid' },
            h(Field, { label: 'ID' }, h('input', { className: 'sm-input', value: snippet.id, onChange: e => setSnippet({ ...snippet, id: e.target.value }), placeholder: 'websocket-headers' })),
            h(Field, { label: '名称' }, h('input', { className: 'sm-input', value: snippet.name, onChange: e => setSnippet({ ...snippet, name: e.target.value }), placeholder: 'WebSocket 头' })),
            h(Field, { label: '内容', wide: true, hint: '整段 Caddyfile 指令，会放进站点的 handle 序列之后' },
              h('textarea', { className: 'sm-input sm-mono sm-code', rows: 6, value: snippet.content, onChange: e => setSnippet({ ...snippet, content: e.target.value }), placeholder: '@ws {\n\tpath /ws*\n}\nhandle @ws {\n\treverse_proxy 127.0.0.1:9000\n}' })),
          ),
          h('div', { className: 'sm-row-actions' }, h(Btn, { kind: 'primary', onClick: saveSnippet, disabled: busy }, busy ? '保存中…' : '保存片段')),
        ),
      )
    }

    /* ───────────────────────── 设置页 ───────────────────────── */

    function SettingsTab({ state, act, notify, refresh }) {
      const [draft, setDraft] = useState({
        proxyListen: state.settings.proxyListen,
        adminEndpoint: state.settings.adminEndpoint,
        caddyExe: state.settings.caddyExe,
        caddyfile: state.settings.caddyfile,
        autoStartCaddy: state.settings.autoStartCaddy !== false,
        trustProxyHeaders: state.settings.trustProxyHeaders !== false,
      })
      const [busy, setBusy] = useState(false)
      const save = async () => {
        setBusy(true)
        try {
          await act('/settings', { settings: draft }, '设置已保存')
          await refresh(true)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'sm-stack' },
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '数据目录'),
          h('div', { className: 'sm-kv' }, h('span', null, '目录'), h('code', { className: 'sm-wrap' }, state.dataDir)),
          h('div', { className: 'sm-kv' }, h('span', null, 'Caddyfile'), h('code', { className: 'sm-wrap' }, state.caddyfile)),
          h('p', { className: 'sm-muted' }, '数据目录来自插件配置 dataDir（默认 <DSH_HOME>/service-manage）。服务和路由的登记、日志、生成的 Caddyfile 都在这里。'),
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '代理设置'),
          h('div', { className: 'sm-grid' },
            h(Field, { label: '监听地址', hint: '例如 :8080' }, h('input', { className: 'sm-input sm-mono', value: draft.proxyListen, onChange: e => setDraft({ ...draft, proxyListen: e.target.value }) })),
            h(Field, { label: 'Caddy 管理接口' }, h('input', { className: 'sm-input sm-mono', value: draft.adminEndpoint, onChange: e => setDraft({ ...draft, adminEndpoint: e.target.value }) })),
            h(Field, { label: 'caddy 可执行文件', wide: true }, h('input', { className: 'sm-input sm-mono', value: draft.caddyExe, onChange: e => setDraft({ ...draft, caddyExe: e.target.value }) })),
            h(Field, { label: '主 Caddyfile', wide: true, hint: '留空使用数据目录下的 caddy/Caddyfile' }, h('input', { className: 'sm-input sm-mono', value: draft.caddyfile, onChange: e => setDraft({ ...draft, caddyfile: e.target.value }) })),
            h(Field, { label: '随 DSH 启动 Caddy' }, h('select', { className: 'sm-input', value: draft.autoStartCaddy ? 'yes' : 'no', onChange: e => setDraft({ ...draft, autoStartCaddy: e.target.value === 'yes' }) },
              h('option', { value: 'yes' }, '是'), h('option', { value: 'no' }, '否'))),
            h(Field, { label: '信任代理头', hint: '从 X-Forwarded-For 解析真实客户端' }, h('select', { className: 'sm-input', value: draft.trustProxyHeaders ? 'yes' : 'no', onChange: e => setDraft({ ...draft, trustProxyHeaders: e.target.value === 'yes' }) },
              h('option', { value: 'yes' }, '是'), h('option', { value: 'no' }, '否'))),
          ),
          h('div', { className: 'sm-row-actions' }, h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存设置')),
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, 'Caddy 自启方式'),
          h('div', { className: 'sm-kv' }, h('span', null, '当前'),
            h('strong', null, state.caddy.windowsService?.exists ? 'Windows 服务' : '登录脚本')),
          h('div', { className: 'sm-row-actions' },
            h('select', {
              className: 'sm-input sm-mode',
              value: state.caddy.windowsService?.exists ? 'service' : 'script',
              onChange: async event => {
                const data = await act('/caddy/boot-mode', { mode: event.target.value })
                if (data?.result?.ok === false) {
                  notify(`需要管理员权限：${data.result.plan?.command ?? data.result.output}`)
                } else {
                  notify(event.target.value === 'service' ? 'Caddy 已改为 Windows 服务' : 'Caddy 已改为登录脚本自启')
                }
              },
            },
              h('option', { value: 'script' }, '登录脚本'),
              h('option', { value: 'service' }, 'Windows 服务'),
            ),
          ),
          h('p', { className: 'sm-muted' },
            '登录脚本：登录后隐藏窗口启动；Windows 服务：开机即启、不需要登录，但注册需要管理员权限。切换时会先停掉当前进程，再由另一种方式接管。'),
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '开机自启'),
          h('div', { className: 'sm-kv' }, h('span', null, '状态'), h('strong', null, state.autostart ? '已开启' : '已关闭')),
          h('div', { className: 'sm-kv' }, h('span', null, '管理员权限'), h('strong', null, state.elevated ? '有' : '无')),
          h('p', { className: 'sm-muted' }, '开启后会在 HKCU\\…\\Run 写入一条启动项，登录时用隐藏窗口拉起 Caddy 和标记为“开机自启”的服务；注册为 Windows 服务需要管理员权限。'),
          h('div', { className: 'sm-row-actions' },
            state.autostart
              ? h(Btn, { kind: 'danger', onClick: () => act('/autostart', { enabled: false }, '已关闭开机自启') }, '关闭开机自启')
              : h(Btn, { kind: 'primary', onClick: () => act('/autostart', { enabled: true }, '已开启开机自启') }, '开启开机自启'),
          ),
        ),
      )
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    const CSS = `
.sm-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;overflow:hidden}
.sm-head{border-bottom:1px solid var(--dsw-alias-border-l1);padding:12px 18px 0;flex:none}
.sm-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sm-title{font-size:15px}
.sm-pills{display:flex;gap:6px;flex-wrap:wrap}
.sm-spacer{flex:1}
.sm-tabs{display:flex;gap:2px;margin-top:10px}
.sm-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 12px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px}
.sm-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sm-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}
.sm-body{flex:1;overflow:auto;padding:16px 18px 28px}
.sm-stack{display:flex;flex-direction:column;gap:12px}
.sm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.sm-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px}
.sm-card-title{font-weight:600;margin-bottom:6px}
.sm-card-value{font-size:22px;font-weight:600;letter-spacing:.5px}
.sm-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.sm-mt{margin-top:8px}
.sm-desc{margin-top:2px}
.sm-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.sm-row-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.sm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 11px;border-radius:7px;cursor:pointer;font-size:12px}
.sm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.sm-btn:disabled{opacity:.5;cursor:default}
.sm-btn[data-kind="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.sm-btn[data-kind="danger"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sm-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sm-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.sm-pill[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.sm-pill[data-tone="plain"]{border-color:var(--dsw-alias-border-l1)}
.sm-table{display:flex;flex-direction:column;gap:2px}
.sm-table-card{gap:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.sm-tr{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px}
.sm-tr:hover{background:var(--dsw-alias-bg-layer-2)}
.sm-td{min-width:0}
.sm-grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-service{display:flex;flex-direction:column;gap:6px}
.sm-service-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.sm-service-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1}
.sm-route{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sm-route:last-child{border-bottom:0}
.sm-route-main{flex:1;min-width:0}
.sm-route-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sm-kv{display:flex;gap:8px;font-size:12px;align-items:baseline}
.sm-kv > span{color:var(--dsw-alias-label-secondary);flex:none;min-width:52px}
.sm-kv code{background:var(--dsw-alias-bg-layer-2);padding:1px 6px;border-radius:5px;font-size:12px}
.sm-wrap{white-space:pre-wrap;word-break:break-all}
.sm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.sm-empty{padding:26px;text-align:center;color:var(--dsw-alias-label-secondary)}
.sm-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;font-size:12px;white-space:pre-wrap}
.sm-banner{margin:10px 18px 0;flex:none}
.sm-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 10px;font-size:12px}
.sm-ok{color:var(--dsw-alias-state-success-primary)}
.sm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 14px}
.sm-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.sm-field[data-wide="true"]{grid-column:1/-1}
.sm-field-label{color:var(--dsw-alias-label-secondary)}
.sm-field-hint{color:var(--dsw-alias-label-secondary);font-size:11px;opacity:.8}
.sm-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 8px;font-size:12px;min-width:0;font-family:inherit}
.sm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sm-mode{width:auto;min-width:106px;padding:4px 6px}
.sm-code{width:100%;resize:vertical;line-height:1.5}
.sm-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}
.sm-modal{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;width:min(560px,100%);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.35)}
.sm-modal[data-wide="true"]{width:min(760px,100%)}
.sm-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sm-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.sm-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.sm-x{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:1;cursor:pointer;padding:0 4px}
.sm-log{margin:0;background:#0d1418;color:#cfe8df;border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.45;max-height:52vh;overflow:auto;white-space:pre-wrap;word-break:break-all}
.sm-log-sm{max-height:200px}
.sm-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:6px 16px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:70}
`

    /* ───────────────────────── 侧栏图标 ───────────────────────── */

    function PanelIcon(props) {
      const size = props?.size ?? 20
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 3, y: 4, width: 18, height: 5, rx: 1.6 }),
        h('rect', { x: 3, y: 10.5, width: 18, height: 5, rx: 1.6 }),
        h('rect', { x: 3, y: 17, width: 18, height: 5, rx: 1.6 }),
        h('circle', { cx: 6.5, cy: 6.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 6.5, cy: 13, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 6.5, cy: 19.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'service-manage',
        }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'service-manage',
          order: 30,
          label: '服务',
        }, PanelIcon))
      },
    }
  },
})
