/**
 * Manual smoke test: build a realistic configuration in a scratch directory and
 * print the files. Validate them with the real binary:
 *   node test/smoke-caddy.mjs
 *   caddy validate --config .smoke/caddy/Caddyfile
 * (The script does not spawn Caddy itself, so it also runs where child output
 * cannot be captured.)
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

import { Caddy } from '../lib/caddy.js'
import { Store } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, '..', '.smoke')

// Fixed bcrypt hash (cost 14) so the render needs no subprocess.
const hash = '$2a$14$ivo7y0DRvVPebiCCgAf14Olfk00NNOrpb5XhRuqPlV2nlMDBR7gNe'

const store = new Store({ dataDir, config: {} })
await store.load()
store.state.settings.proxyListen = ':18080'
store.state.settings.adminEndpoint = '127.0.0.1:12019'
store.state.routes = []
store.state.snippets = []

await store.upsertRoute({ id: 'v1', name: 'API', path: '/v1', upstream: '127.0.0.1:8090', cors: true })
await store.upsertRoute({ id: 'image', name: 'UI', path: '/image', upstream: '127.0.0.1:8090', stripPrefix: true, order: 10 })
await store.upsertRoute({
  id: 'comfyui',
  name: 'ComfyUI',
  path: '/comfyui',
  upstream: '127.0.0.1:9199',
  stripPrefix: true,
  headerUp: { 'X-Forwarded-Prefix': '/comfyui' },
  auth: { type: 'basic', user: 'admin', hash },
  order: 20,
})
await store.upsertRoute({ id: 'comfyui-root', name: 'ComfyUI slash', path: '/comfyui', exact: true, kind: 'redirect', to: '/comfyui/', order: 21 })
await store.upsertRoute({
  id: 'status',
  name: 'Status page',
  path: '/status',
  exact: true,
  kind: 'static',
  root: 'D:/Documents/deepseek-harness/default-workspace/caddy',
  rewrite: '/status.html',
  order: 30,
})
await store.upsertSnippet({ id: 'ws', name: 'WebSocket demo', content: '@ws {\n\tpath /ws*\n}\nhandle @ws {\n\treverse_proxy 127.0.0.1:9000\n}' })

const caddy = new Caddy(store)
const rendered = await caddy.render()

console.log('--- rendered ---')
console.log(rendered)
console.log('--- Caddyfile ---')
console.log(await readFile(caddy.configPath, 'utf8'))
console.log('--- routes/_managed.caddy ---')
console.log(await readFile(caddy.managedRoutePath, 'utf8'))
console.log(`\nValidate with:\n  caddy validate --config ${caddy.configPath}`)
