/**
 * Same-origin HTTP API for the panel. Registered on `ctx.webServer` under
 * `/service-manage`, fenced to loopback and a loopback Host header so a remote
 * browser cannot reach it even when the Web GUI is exposed.
 */
import { isLoopbackAddress, isElevated, pidOnPort } from './util.js'
import { isAutostartEnabled, registerWindowsService, setAutostart, unregisterWindowsService, windowsServicePlan } from './windows.js'

const PREFIX = '/service-manage'
const MAX_BODY = 2 * 1024 * 1024

/**
 * Decide whether a request may use this API.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} true when the peer and Host are loopback.
 */
export function isTrustedLocalRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const host = String(req.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/**
 * Build the request handler bound to one plugin instance.
 * @param {{store: import('./store.js').Store, supervisor: import('./services.js').Supervisor, caddy: import('./caddy.js').Caddy}} deps - runtime services.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createApiHandler({ store, supervisor, caddy }) {
  return async function handler(req, res) {
    if (!isTrustedLocalRequest(req)) {
      send(res, 403, { ok: false, error: 'this API is available on loopback only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX)) {
      send(res, 404, { ok: false, error: 'not found' })
      return
    }
    const route = url.pathname.slice(PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && route === '/state') {
        send(res, 200, { ok: true, data: await snapshot() })
        return
      }
      if (req.method === 'GET' && route === '/logs') {
        const id = url.searchParams.get('id') ?? ''
        const lines = Number(url.searchParams.get('lines') ?? 200)
        send(res, 200, { ok: true, data: await supervisor.logs(id, lines) })
        return
      }
      if (req.method === 'GET' && route === '/caddy/file') {
        send(res, 200, { ok: true, data: await caddy.readConfig() })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      const data = await dispatch(route, body)
      send(res, 200, { ok: true, data })
    } catch (error) {
      send(res, 200, { ok: false, error: String(error?.message ?? error) })
    }

    /**
     * Route one authenticated POST.
     * @param {string} name - path below the prefix.
     * @param {Record<string, any>} body - parsed body.
     * @returns {Promise<any>} response payload.
     */
    async function dispatch(name, body) {
      switch (name) {
        case '/service/save': {
          const saved = await store.upsertService(body.service ?? body)
          return { service: saved, state: await snapshot() }
        }
        case '/service/delete': {
          await supervisor.stop(String(body.id ?? ''))
          const removed = await store.removeService(String(body.id ?? ''))
          if (store.state.caddy.mode === 'managed') await caddy.render()
          return { removed, state: await snapshot() }
        }
        case '/service/action': {
          const id = String(body.id ?? '')
          const action = String(body.action ?? '')
          let result
          if (action === 'start') result = await supervisor.start(id)
          else if (action === 'stop') result = await supervisor.stop(id)
          else if (action === 'restart') result = await supervisor.restart(id)
          else if (action === 'logs') return supervisor.logs(id, Number(body.lines ?? 200))
          else throw new Error(`unknown action: ${action}`)
          return { result, state: await snapshot() }
        }
        case '/route/save': {
          const input = { ...(body.route ?? body) }
          const auth = { ...(input.auth ?? {}) }
          if (auth.type === 'basic') {
            const clientHash = typeof auth.hash === 'string' && auth.hash.startsWith('$2') ? auth.hash : ''
            if (typeof auth.password === 'string' && auth.password.length > 0) {
              auth.hash = await caddy.hashPassword(auth.password)
            } else if (clientHash) {
              auth.hash = clientHash
            } else if (input.id) {
              auth.hash = store.route(String(input.id))?.auth?.hash ?? ''
            }
            if (!auth.hash) throw new Error('basic auth needs a password')
            delete auth.password
          } else {
            auth.hash = ''
            delete auth.password
          }
          input.auth = auth
          const saved = await store.upsertRoute(input)
          const applied = await caddy.apply()
          return { route: saved, applied, state: await snapshot() }
        }
        case '/route/delete': {
          const removed = await store.removeRoute(String(body.id ?? ''))
          const applied = await caddy.apply()
          return { removed, applied, state: await snapshot() }
        }
        case '/snippet/save': {
          const snippet = await store.upsertSnippet(body.snippet ?? body)
          const applied = await caddy.apply()
          return { snippet, applied, state: await snapshot() }
        }
        case '/snippet/delete': {
          const removed = await store.removeSnippet(String(body.id ?? ''))
          const applied = await caddy.apply()
          return { removed, applied, state: await snapshot() }
        }
        case '/caddy/action': {
          const action = String(body.action ?? '')
          let result
          if (action === 'validate') result = await caddy.validate()
          else if (action === 'reload') result = await caddy.reload()
          else if (action === 'apply') result = await caddy.apply()
          else if (action === 'start') result = await caddy.start()
          else if (action === 'stop') result = await caddy.stop()
          else if (action === 'render') result = await caddy.render({ force: true })
          else throw new Error(`unknown action: ${action}`)
          return { result, state: await snapshot() }
        }
        case '/caddy/file': {
          const result = await caddy.writeConfig(String(body.content ?? ''))
          return { result, state: await snapshot() }
        }
        case '/caddy/mode': {
          const mode = body.mode === 'manual' ? 'manual' : 'managed'
          await store.setCaddyMode(mode)
          const rendered = mode === 'managed' ? await caddy.apply() : undefined
          return { mode, rendered, state: await snapshot() }
        }
        case '/settings': {
          const settings = await store.updateSettings(body.settings ?? body)
          const rendered = store.state.caddy.mode === 'managed' ? await caddy.apply() : undefined
          return { settings, rendered, state: await snapshot() }
        }
        case '/autostart': {
          const result = await setAutostart(store, body.enabled !== false)
          return { result, state: await snapshot() }
        }
        case '/windows-service': {
          const id = String(body.id ?? '')
          const service = store.service(id)
          if (!service) throw new Error(`unknown service: ${id}`)
          const action = String(body.action ?? 'install')
          let result
          if (action === 'install') result = await registerWindowsService(store, service)
          else if (action === 'uninstall') result = await unregisterWindowsService(store, service)
          else if (action === 'plan') result = await windowsServicePlan(store, service)
          else throw new Error(`unknown action: ${action}`)
          return { result, state: await snapshot() }
        }
        default:
          throw new Error(`unknown endpoint: ${name}`)
      }
    }

    /**
     * Compose the panel's full view.
     * @returns {Promise<Record<string, any>>} the snapshot.
     */
    async function snapshot() {
      const status = await caddy.status(800)
      const listen = String(store.settings.proxyListen ?? ':8080')
      const port = Number(listen.slice(listen.lastIndexOf(':') + 1))
      const proxyPid = Number.isInteger(port) ? await pidOnPort(port) : undefined
      const services = await supervisor.snapshot()
      return {
        dataDir: store.dataDir,
        caddyfile: store.caddyfile,
        mode: store.state.caddy.mode,
        settings: store.settings,
        caddy: {
          ...status,
          running: status.reachable || proxyPid !== undefined,
          port,
          pid: proxyPid,
        },
        services,
        routes: store.routes,
        snippets: store.snippets,
        autostart: await isAutostartEnabled(),
        elevated: await isElevated(),
      }
    }
  }
}

/**
 * Read a JSON request body with a size cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, any>>} parsed body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error?.message ?? error)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON body.
 * @returns {void}
 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
