/**
 * Render smoke test for the browser half. It loads `client.js` the way the DSH
 * module loader does, fakes the slot registry, and server-renders every tab
 * against a fixture so a broken expression fails here instead of blanking the
 * panel.
 *
 * React comes from the DSH installation:
 *   DSH_REACT_ROOT="<dsh app>/resources/app/dsh/node_modules" node test/client-render.mjs
 * Without a resolvable React the test reports a skip and exits 0.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const roots = [
  process.env.DSH_REACT_ROOT,
  path.join(here, '..'),
  'F:/Deepseek Harness/resources/app/dsh/node_modules',
].filter(Boolean)

let React
let renderToString
for (const root of roots) {
  try {
    const req = createRequire(path.join(root, 'anchor.cjs'))
    React = req('react')
    renderToString = req('react-dom/server').renderToString
    if (React && renderToString) break
  } catch {
    React = undefined
  }
}

if (!React || !renderToString) {
  console.log('SKIP: react/react-dom not resolvable; set DSH_REACT_ROOT to <dsh>/node_modules')
  process.exit(0)
}

let definition
const sandbox = {
  window: {
    __ModuleLoader__: { load: value => { definition = value } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => true,
  },
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  clearInterval: () => {},
  setInterval: () => 0,
  fetch: async () => { throw new Error('no network in render test') },
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(path.join(here, '..', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })

assert.ok(definition, 'client.js must call window.__ModuleLoader__.load')
assert.equal(definition.id, 'dsh-service-manage', 'module id must equal the package name')

const factory = definition.factory
const module = factory(specifier => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
assert.equal(Array.from(module.inject).join(','), 'slots')

const registrations = []
const ctx = {
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => { registrations.push({ options, component }) },
  },
}
module.apply(ctx)

assert.equal(registrations.length, 2, 'one sidebar entry and one main panel')
const main = registrations.find(item => item.options.name === 'main')
const sidebar = registrations.find(item => item.options.name === 'sidebar.panellist')
assert.equal(main.options.key, 'service-manage')
assert.equal(sidebar.options.id, 'service-manage')
assert.ok(typeof sidebar.component === 'function')

const fixture = {
  dataDir: 'C:\\Users\\me\\.dsh\\service-manage',
  caddyfile: 'C:\\Users\\me\\.dsh\\service-manage\\caddy\\Caddyfile',
  mode: 'managed',
  settings: {
    proxyListen: ':8080',
    adminEndpoint: 'localhost:2019',
    caddyExe: 'caddy',
    caddyfile: '',
    autoStartCaddy: true,
    trustProxyHeaders: true,
  },
  caddy: { running: true, reachable: true, admin: 'localhost:2019', listens: [':8080'], port: 8080, pid: 1234 },
  services: [
    {
      id: 'image-api', name: '生图 API', description: 'ComfyUI 生图接口', cwd: 'D:\\services\\image-api',
      command: '"F:\\Miniconda3\\python.exe" main.py', env: { PORT: '8090' }, port: 8090, healthPath: '/health',
      autoStart: 'boot', manage: 'process', running: true, owned: true, pid: 4321, uptimeMs: 3_600_000,
      health: { ok: true, status: 200 }, lastExit: undefined,
    },
    {
      id: 'comfyui', name: 'ComfyUI', description: '', cwd: '', command: '', env: {}, port: 9199, healthPath: '',
      autoStart: 'none', manage: 'external', running: true, owned: false, pid: 2224, health: undefined,
    },
  ],
  routes: [
    {
      id: 'image', name: '生图前端', order: 30, enabled: true, kind: 'proxy',
      match: { path: '/image', exact: false, host: '' }, stripPrefix: false, upstream: '127.0.0.1:8090',
      headerUp: {}, auth: { type: 'none', user: '', hash: '' }, cors: false,
      redirect: { to: '', code: 308 }, static: { root: '', rewrite: '' },
    },
    {
      id: 'comfyui', name: 'ComfyUI', order: 40, enabled: true, kind: 'proxy',
      match: { path: '/comfyui/*', exact: false, host: '' }, stripPrefix: true, upstream: '127.0.0.1:9199',
      headerUp: { 'X-Forwarded-Prefix': '/comfyui' }, auth: { type: 'basic', user: 'admin', hash: '$2a$14$x' }, cors: false,
      redirect: { to: '', code: 308 }, static: { root: '', rewrite: '' },
    },
  ],
  snippets: [{ id: 'access-log', name: '访问日志', order: 10, content: 'log { format console }' }],
  autostart: true,
  elevated: false,
}

const expectations = {
  overview: ['本地服务管理', '反向代理', '生图 API', 'Caddy 运行中'],
  services: ['停止', '重启', 'Windows 服务', 'ComfyUI', '8090'],
  routes: ['/image', '127.0.0.1:8090', 'Basic', '新增路由'],
  advanced: ['Caddyfile', '自定义片段', '切换为手动模式'],
  settings: ['数据目录', '开机自启', '监听地址'],
}

for (const [tab, needles] of Object.entries(expectations)) {
  const html = renderToString(React.createElement(main.component, { initialState: fixture, initialTab: tab }))
  for (const needle of needles) {
    assert.ok(html.includes(needle), `${tab} tab should render ${JSON.stringify(needle)}`)
  }
  console.log(`ok ${tab} (${html.length} bytes)`)
}

const loading = renderToString(React.createElement(main.component, {}))
assert.ok(loading.includes('正在读取服务状态'), 'initial render shows the loading state')
console.log('ok loading state')
