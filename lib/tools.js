/**
 * Agent-facing tools. Five tools cover the whole surface so the model does not
 * need to learn a large vocabulary: read state, control a process, edit a
 * service, edit a route, and take over the raw Caddyfile.
 */
import { isElevated } from './util.js'
import { registerWindowsService, unregisterWindowsService, windowsServicePlan } from './windows.js'

/** Cap a rendered payload so one tool result cannot flood the context. */
const MAX_TEXT = 12000

/**
 * Register the service-manager tools on the calling context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `tools`.
 * @param {{store: import('./store.js').Store, supervisor: import('./services.js').Supervisor, caddy: import('./caddy.js').Caddy}} deps - runtime services.
 * @returns {void}
 */
export function registerTools(ctx, { store, supervisor, caddy }) {
  /**
   * Register one tool, coercing its result to lossless JSON. Several results
   * carry optional fields whose value is undefined, and the tool contract
   * rejects those before the model ever sees them.
   * @param {Record<string, any>} definition - tool definition.
   * @returns {void}
   */
  function register(definition) {
    const run = definition.execute
    definition.execute = async (...args) => {
      const value = await run(...args)
      if (value === undefined) return null
      try {
        return JSON.parse(JSON.stringify(value))
      } catch {
        return { error: 'tool result was not serializable' }
      }
    }
    ctx.tools.register(definition, { label: 'service-manager' })
  }

  /**
   * Build the summary every read tool returns.
   * @returns {Promise<Record<string, any>>} the state.
   */
  async function readState() {
    const services = await supervisor.snapshot()
    const status = await caddy.status(800)
    return {
      dataDir: store.dataDir,
      caddyfile: store.caddyfile,
      mode: store.state.caddy.mode,
      caddy: {
        running: status.reachable,
        admin: status.admin,
        listens: status.listens,
        listen: store.settings.proxyListen,
      },
      services: services.map(service => ({
        id: service.id,
        name: service.name,
        running: service.running,
        pid: service.pid,
        port: service.port,
        health: service.health?.ok,
        autoStart: service.autoStart,
        manage: service.manage,
        command: service.command,
        cwd: service.cwd,
      })),
      routes: store.routes.map(route => ({
        id: route.id,
        enabled: route.enabled,
        kind: route.kind,
        match: route.match.host ? `${route.match.host}${route.match.path}` : route.match.path,
        to: route.kind === 'proxy' ? route.upstream : route.kind === 'redirect' ? route.redirect.to : route.static.root,
        auth: route.auth.type,
      })),
    }
  }

  register({
    name: 'service_status',
    description:
      'Read the local service manager: every managed service with its running state, pid, port and health, '
      + 'the Caddy proxy state, and the configured reverse-proxy routes. Start here, and call it again after a change to verify it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [text(value)] },
    async execute() {
      return readState()
    },
  })

  register({
    name: 'service_control',
    description:
      'Start, stop, restart, or read the recent log of one managed service. A service already listening on its port '
      + 'is reported instead of started twice; stopping works even for a process this manager did not launch.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Service id from service_status.' },
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'logs'], description: 'Operation to perform.' },
        lines: { type: 'integer', description: 'For action "logs": how many trailing lines, 20-500 (default 120).' },
      },
      required: ['id', 'action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [text(value)] },
    async execute(args) {
      const id = String(args.id)
      const action = String(args.action)
      if (action === 'logs') {
        const tail = await supervisor.logs(id, Number(args.lines ?? 120))
        return { id, source: tail.source, lines: tail.lines }
      }
      const result = action === 'start'
        ? await supervisor.start(id)
        : action === 'stop'
          ? await supervisor.stop(id)
          : action === 'restart'
            ? await supervisor.restart(id)
            : (() => { throw new Error(`unknown action: ${action}`) })()
      return { id, action, ok: result.ok, output: result.output, status: result.status }
    },
  })

  register({
    name: 'service_config',
    description:
      'Create or update one service definition, delete it, or prepare/register a Windows service for it. '
      + 'A definition stores the working directory, the launch command, an optional port and health path, and whether it '
      + 'starts with DSH, at user login, or only by hand. Registration needs an elevated shell and returns the ready script when it is not.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['upsert', 'delete', 'windows-plan', 'windows-install', 'windows-uninstall'],
          description: 'Definition change, or one Windows-service step.',
        },
        id: { type: 'string', description: 'Service id; omit on upsert to create a new one.' },
        name: { type: 'string', description: 'Display name.' },
        description: { type: 'string', description: 'What the service does.' },
        cwd: { type: 'string', description: 'Working directory (absolute path).' },
        command: { type: 'string', description: 'Launch command, run through cmd.exe; quote an absolute executable path.' },
        port: { type: 'integer', description: 'TCP port the service listens on, used for status and conflict checks.' },
        healthPath: { type: 'string', description: 'HTTP path probed on that port, e.g. /health.' },
        autoStart: { type: 'string', enum: ['none', 'dsh', 'boot'], description: 'Start manually, when DSH starts, or at user login.' },
        manage: { type: 'string', enum: ['process', 'external'], description: 'process: this manager starts and stops it. external: only observe it.' },
        env: { type: 'object', description: 'Extra environment variables for the process.', additionalProperties: { type: 'string' } },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [text(value)] },
    async execute(args) {
      const action = String(args.action)
      if (action === 'delete') {
        const id = String(args.id ?? '')
        await supervisor.stop(id)
        const removed = await store.removeService(id)
        if (store.state.caddy.mode === 'managed') await caddy.render()
        return { removed, id }
      }
      if (action.startsWith('windows-')) {
        const service = store.service(String(args.id ?? ''))
        if (!service) throw new Error(`unknown service: ${args.id}`)
        if (action === 'windows-plan') return windowsServicePlan(store, service)
        if (action === 'windows-uninstall') {
          const result = await unregisterWindowsService(store, service)
          return { ...result, elevated: await isElevated() }
        }
        const result = await registerWindowsService(store, service)
        return { ...result, elevated: await isElevated() }
      }
      const service = await store.upsertService({
        id: args.id,
        name: args.name,
        description: args.description,
        cwd: args.cwd,
        command: args.command,
        port: args.port,
        healthPath: args.healthPath,
        autoStart: args.autoStart,
        manage: args.manage,
        env: args.env,
      })
      return { service, next: 'use service_control with action "start" to launch it' }
    },
  })

  register({
    name: 'proxy_route',
    description:
      'List, create, update, or delete one reverse-proxy route. A route matches a path (optionally an exact path or a host), '
      + 'then either proxies to an upstream, redirects, or serves files. Saving regenerates the Caddyfile, validates it, and '
      + 'reloads Caddy; when validation fails the previous configuration is restored. In manual mode routes are recorded but '
      + 'the hand-written Caddyfile stays in charge.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'upsert', 'delete'], description: 'What to do.' },
        id: { type: 'string', description: 'Route id; omit on upsert to create one from the path.' },
        name: { type: 'string', description: 'Display name.' },
        path: { type: 'string', description: 'Path prefix, e.g. /image. Without exact it also matches /image/... .' },
        exact: { type: 'boolean', description: 'Match only the exact path.' },
        host: { type: 'string', description: 'Optional host matcher.' },
        kind: { type: 'string', enum: ['proxy', 'redirect', 'static'], description: 'Handler kind (default proxy).' },
        upstream: { type: 'string', description: 'Proxy target, e.g. 127.0.0.1:8090.' },
        stripPrefix: { type: 'boolean', description: 'Strip the matched path before proxying.' },
        cors: { type: 'boolean', description: 'Add permissive CORS headers and answer OPTIONS with 204.' },
        to: { type: 'string', description: 'Redirect target.' },
        code: { type: 'integer', description: 'Redirect status code (default 308).' },
        root: { type: 'string', description: 'Static file root directory.' },
        rewrite: { type: 'string', description: 'Static rewrite target, e.g. /index.html.' },
        order: { type: 'integer', description: 'Evaluation order, ascending (default 100).' },
        enabled: { type: 'boolean', description: 'Whether the route is rendered.' },
        auth: {
          type: 'object',
          description:
            'Access control. type basic needs user plus password (hashed on save) or an existing bcrypt hash.',
          properties: {
            type: { type: 'string', enum: ['none', 'basic'] },
            user: { type: 'string' },
            password: { type: 'string' },
            hash: { type: 'string', description: 'Existing bcrypt hash to reuse instead of a password.' },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [text(value)] },
    async execute(args) {
      const action = String(args.action)
      if (action === 'list') {
        return { mode: store.state.caddy.mode, routes: store.routes }
      }
      if (action === 'delete') {
        const removed = await store.removeRoute(String(args.id ?? ''))
        const applied = await caddy.apply()
        return { removed, applied }
      }
      const auth = { type: 'none', user: '', hash: '' }
      if (args.auth && args.auth.type === 'basic') {
        auth.type = 'basic'
        auth.user = String(args.auth.user ?? '')
        const password = typeof args.auth.password === 'string' ? args.auth.password : ''
        const given = typeof args.auth.hash === 'string' && args.auth.hash.startsWith('$2') ? args.auth.hash : ''
        auth.hash = given
          || (password.length > 0
            ? await caddy.hashPassword(password)
            : (store.route(String(args.id ?? ''))?.auth?.hash ?? ''))
        if (!auth.hash) throw new Error('basic auth needs a password or an existing bcrypt hash')
      }
      const route = await store.upsertRoute({
        id: args.id,
        name: args.name,
        path: args.path,
        exact: args.exact,
        host: args.host,
        kind: args.kind,
        upstream: args.upstream,
        stripPrefix: args.stripPrefix,
        cors: args.cors,
        to: args.to,
        code: args.code,
        root: args.root,
        rewrite: args.rewrite,
        order: args.order,
        enabled: args.enabled,
        auth,
      })
      const applied = await caddy.apply()
      return {
        route,
        applied,
        note: store.state.caddy.mode === 'manual'
          ? 'Caddyfile is in manual mode: the route is stored but not rendered. Switch to managed to apply routes.'
          : undefined,
      }
    },
  })

  register({
    name: 'caddy_config',
    description:
      'Work on the whole Caddyfile: read it, replace it by hand (which switches to manual mode), validate, reload, '
      + 'start or stop the proxy, switch back to generated routes, or maintain hand-written snippets. Use this for anything '
      + 'the structured route model cannot express; a snippet is imported inside the site block and survives route regeneration.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'read', 'write', 'validate', 'reload', 'start', 'stop', 'set-mode',
            'snippet-list', 'snippet-upsert', 'snippet-delete',
          ],
          description: 'Operation to perform.',
        },
        content: { type: 'string', description: 'For action "write": the complete Caddyfile body.' },
        mode: { type: 'string', enum: ['managed', 'manual'], description: 'For action "set-mode".' },
        snippet: {
          type: 'object',
          description: 'For snippet actions: the Caddyfile fragment and its id/name.',
          properties: {
            id: { type: 'string', description: 'Stable id; becomes custom/<id>.caddy.' },
            name: { type: 'string' },
            content: { type: 'string', description: 'Directives placed inside the site block.' },
            order: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [text(value)] },
    async execute(args) {
      const action = String(args.action)
      if (action === 'read') return caddy.readConfig()
      if (action === 'write') return caddy.writeConfig(String(args.content ?? ''))
      if (action === 'validate') return caddy.validate()
      if (action === 'reload') return caddy.reload()
      if (action === 'start') return caddy.start()
      if (action === 'stop') return caddy.stop()
      if (action === 'set-mode') {
        const mode = args.mode === 'manual' ? 'manual' : 'managed'
        await store.setCaddyMode(mode)
        if (mode === 'managed') return { mode, ...(await caddy.apply()) }
        return { mode, note: 'the current Caddyfile is now owned by hand' }
      }
      if (action === 'snippet-list') return { mode: store.state.caddy.mode, snippets: store.snippets }
      if (action === 'snippet-upsert') {
        const snippet = await store.upsertSnippet(args.snippet ?? {})
        const applied = await caddy.apply()
        return { snippet, applied }
      }
      if (action === 'snippet-delete') {
        const removed = await store.removeSnippet(String(args.snippet?.id ?? ''))
        const applied = await caddy.apply()
        return { removed, applied }
      }
      throw new Error(`unknown action: ${action}`)
    },
  })
}

/**
 * Turn a value into one bounded text content block.
 * @param {unknown} value - tool result.
 * @returns {{type: 'text', text: string}} the block.
 */
function text(value) {
  let body
  if (typeof value === 'string') body = value
  else body = JSON.stringify(value, null, 2)
  if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}\n… (truncated)`
  return { type: 'text', text: body }
}
