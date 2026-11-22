/**
 * Click smoke test for the browser half.
 *
 * The panel builds its element tree and then defines its helpers below the
 * `return`, so a helper declared with `const` would sit in the temporal dead
 * zone: the buttons render, the click throws `Cannot access ... before
 * initialization`, and nothing happens at all. `renderToString` cannot see
 * that, so this test runs the component with a tiny fake React, walks the
 * resulting tree, and actually calls the click handlers.
 *
 *   node test/client-click.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/* ── a React small enough to walk ─────────────────────────────────────── */

const createElement = (type, props, ...children) => ({
  type,
  props: {
    ...(props ?? {}),
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
  },
})

const React = {
  createElement,
  Fragment: 'Fragment',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: value => ({ current: value }),
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: factory => factory(),
}

/* ── load client.js the way the DSH loader does ───────────────────────── */

let definition
const calls = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: value => { definition = value } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    confirm: () => true,
  },
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  clearInterval: () => {},
  setInterval: () => 0,
  fetch: async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
    const data = url.endsWith('/state')
      ? fixture
      : { result: { ok: true, output: 'ok' }, state: fixture, opened: 'C:\\x', focused: true }
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, data }) }
  },
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(path.join(here, '..', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })

const module = definition.factory(specifier => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})

const registrations = []
module.apply({
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => { registrations.push({ options, component }) },
  },
})
const main = registrations.find(item => item.options.name === 'main')

/* ── fixture ──────────────────────────────────────────────────────────── */

const fixture = {
  dataDir: 'C:\\Users\\me\\.dsh\\service-manage',
  pluginDir: 'D:\\plugins\\dsh-service-manage',
  caddyfile: 'C:\\Users\\me\\.dsh\\service-manage\\caddy\\Caddyfile',
  mode: 'managed',
  settings: { proxyListen: ':8080', adminEndpoint: 'localhost:2019', caddyExe: 'caddy', caddyfile: '', autoStartCaddy: true, caddyBootMode: 'script', trustProxyHeaders: true },
  caddy: { running: true, reachable: true, admin: 'localhost:2019', listens: [':8080'], port: 8080, pid: 1234, windowsService: { exists: false, status: 'missing' } },
  services: [
    {
      id: 'image-api', name: '生图 API', description: '', cwd: 'D:\\services\\image-api',
      command: '"F:\\Miniconda3\\python.exe" main.py', env: { PORT: '8090' }, port: 8090, healthPath: '/health',
      autoStart: 'boot', manage: 'process', running: true, owned: true, pid: 4321, uptimeMs: 3_600_000,
      health: { ok: true, status: 200 }, windowsService: { exists: false, status: 'missing' },
    },
  ],
  routes: [],
  snippets: [],
  autostart: true,
  elevated: false,
}

/* ── walk the tree and click ──────────────────────────────────────────── */

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/**
 * Expand components until a real `<button>` shows up.
 * @param node - element tree.
 * @param onButton - called with every expanded button element.
 */
function visitButtons(node, onButton) {
  if (node == null || node === false) return
  if (Array.isArray(node)) {
    node.forEach(item => visitButtons(item, onButton))
    return
  }
  if (typeof node !== 'object') return
  if (node.type === 'button') {
    onButton(node)
    return
  }
  if (typeof node.type === 'function') {
    visitButtons(node.type(node.props), onButton)
    return
  }
  visitButtons(node.props?.children, onButton)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

function findButton(tree, label) {
  let found
  visitButtons(tree, button => {
    if (!found && textOf(button).includes(label)) found = button
  })
  return found
}

const tree = main.component({ initialState: fixture, initialTab: 'services' })
assert.ok(tree, 'panel renders with a fixture')

const restart = findButton(tree, '重启')
assert.ok(restart, 'the service row should render a 重启 button')
assert.equal(typeof restart.props.onClick, 'function', '重启 must be wired to a handler')

await restart.props.onClick()
await tick()
const posted = calls.filter(item => item.method === 'POST')
assert.equal(posted.length, 1, 'clicking 重启 must reach the API')
assert.equal(posted[0].url, '/service-manage/service/action')
assert.deepEqual(posted[0].body, { id: 'image-api', action: 'restart' })
console.log('ok 重启 posts a restart')

const stop = findButton(tree, '停止')
await stop.props.onClick()
await tick()
assert.deepEqual(calls.filter(item => item.method === 'POST').at(-1).body, { id: 'image-api', action: 'stop' })
console.log('ok 停止 posts a stop')

const settings = main.component({ initialState: fixture, initialTab: 'settings' })
const openPlugin = findButton(settings, '打开插件目录')
assert.ok(openPlugin, 'the settings page should render 打开插件目录')
await openPlugin.props.onClick()
await tick()
assert.equal(calls.filter(item => item.method === 'POST').at(-1).url, '/service-manage/open')
assert.deepEqual(calls.filter(item => item.method === 'POST').at(-1).body, { target: 'plugin' })
console.log('ok 打开插件目录 posts /open')
