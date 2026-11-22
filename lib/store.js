/**
 * Durable registry for managed services, reverse-proxy routes and settings.
 *
 * One JSON document lives in the data directory; every mutation rewrites it
 * atomically. The store holds no runtime process state — the supervisor owns
 * that — so a DSH restart only re-reads declared intent.
 */
import path from 'node:path'
import os from 'node:os'
import { ensureDir, nowIso, readJson, slug, writeFileAtomic } from './util.js'

const STATE_VERSION = 1

/** Settings that can be changed from the panel, with their defaults. */
export const DEFAULT_SETTINGS = {
  proxyListen: ':8080',
  adminEndpoint: 'localhost:2019',
  caddyExe: 'caddy',
  caddyfile: '',
  autoStartCaddy: false,
  caddyBootMode: 'script',
  trustProxyHeaders: true,
}

/** @typedef {'none' | 'boot' | 'dsh'} AutoStartMode */
/** @typedef {'process' | 'external'} ManageMode */

/**
 * Resolve the data directory for this installation.
 * @param {{dataDir?: string}} config - plugin row config.
 * @returns {string} absolute data directory.
 */
export function resolveDataDir(config = {}) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim().length > 0) {
    return path.resolve(config.dataDir.trim())
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'service-manage')
}

/** Registry store. */
export class Store {
  /**
   * @param {{dataDir: string, config?: Record<string, any>}} options - resolved directory and row config.
   */
  constructor({ dataDir, config = {} }) {
    this.dataDir = dataDir
    this.config = config
    this.file = path.join(dataDir, 'state.json')
    this.dirs = {
      caddy: path.join(dataDir, 'caddy'),
      routes: path.join(dataDir, 'caddy', 'routes'),
      custom: path.join(dataDir, 'caddy', 'custom'),
      logs: path.join(dataDir, 'logs'),
      autostart: path.join(dataDir, 'autostart'),
      windowsService: path.join(dataDir, 'windows-service'),
    }
    this.state = {
      version: STATE_VERSION,
      settings: { ...DEFAULT_SETTINGS },
      caddy: { mode: 'managed' },
      services: [],
      routes: [],
      snippets: [],
    }
  }

  /** @returns {Record<string, any>} the mutable state document. */
  get settings() {
    return this.state.settings
  }

  /** @returns {Array<Record<string, any>>} declared services. */
  get services() {
    return this.state.services
  }

  /** @returns {Array<Record<string, any>>} declared proxy routes. */
  get routes() {
    return this.state.routes
  }

  /** @returns {Array<Record<string, any>>} hand-written Caddy snippets. */
  get snippets() {
    return this.state.snippets
  }

  /** @returns {string} the effective Caddyfile path. */
  get caddyfile() {
    const configured = this.state.settings.caddyfile
    return configured && configured.trim().length > 0
      ? path.resolve(configured.trim())
      : path.join(this.dirs.caddy, 'Caddyfile')
  }

  /**
   * Load the state document, filling defaults for missing fields.
   * @returns {Promise<void>} resolves once loaded.
   */
  async load() {
    for (const dir of Object.values(this.dirs)) await ensureDir(dir)
    const stored = await readJson(this.file, undefined)
    if (!stored) {
      const settingsOverrides = {}
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (this.config[key] !== undefined) settingsOverrides[key] = this.config[key]
      }
      this.state.settings = { ...DEFAULT_SETTINGS, ...settingsOverrides }
      await this.save()
      return
    }
    const settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) }
    this.state = {
      version: STATE_VERSION,
      settings,
      caddy: { mode: stored.caddy?.mode === 'manual' ? 'manual' : 'managed' },
      services: Array.isArray(stored.services) ? stored.services.map(normalizeService) : [],
      routes: Array.isArray(stored.routes) ? stored.routes.map(normalizeRoute) : [],
      snippets: Array.isArray(stored.snippets) ? stored.snippets.map(normalizeSnippet) : [],
    }
  }

  /**
   * Persist the current state atomically.
   * @returns {Promise<void>} resolves after the write.
   */
  async save() {
    await ensureDir(this.dataDir)
    await writeFileAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  /**
   * Find one service by id.
   * @param {string} id - service id.
   * @returns {Record<string, any> | undefined} the service.
   */
  service(id) {
    return this.state.services.find(item => item.id === id)
  }

  /**
   * Find one route by id.
   * @param {string} id - route id.
   * @returns {Record<string, any> | undefined} the route.
   */
  route(id) {
    return this.state.routes.find(item => item.id === id)
  }

  /**
   * Create or update a service.
   * @param {Record<string, any>} input - service fields; `id` selects an existing row.
   * @returns {Promise<Record<string, any>>} the stored service.
   */
  async upsertService(input) {
    const existing = input.id ? this.service(String(input.id)) : undefined
    const next = normalizeService({
      ...(existing ?? {}),
      ...input,
      id: existing?.id ?? input.id ?? slug(input.name ?? input.command ?? 'service'),
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    })
    if (!next.command && next.manage !== 'external') throw new Error('service command is required')
    const index = this.state.services.findIndex(item => item.id === next.id)
    if (index >= 0) this.state.services[index] = next
    else this.state.services.push(next)
    await this.save()
    return next
  }

  /**
   * Remove one service.
   * @param {string} id - service id.
   * @returns {Promise<boolean>} whether a row was removed.
   */
  async removeService(id) {
    const before = this.state.services.length
    this.state.services = this.state.services.filter(item => item.id !== id)
    if (this.state.services.length === before) return false
    await this.save()
    return true
  }

  /**
   * Create or update a proxy route.
   * @param {Record<string, any>} input - route fields.
   * @returns {Promise<Record<string, any>>} the stored route.
   */
  async upsertRoute(input) {
    const existing = input.id ? this.route(String(input.id)) : undefined
    const merged = { ...(existing ?? {}), ...input }
    const next = normalizeRoute({
      ...merged,
      id: existing?.id ?? input.id ?? slug(`${input.path ?? input.name ?? 'route'}`),
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    })
    if (next.kind === 'proxy' && !next.upstream) throw new Error('a proxy route needs an upstream')
    const index = this.state.routes.findIndex(item => item.id === next.id)
    if (index >= 0) this.state.routes[index] = next
    else this.state.routes.push(next)
    this.state.routes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    await this.save()
    return next
  }

  /**
   * Remove one route.
   * @param {string} id - route id.
   * @returns {Promise<boolean>} whether a row was removed.
   */
  async removeRoute(id) {
    const before = this.state.routes.length
    this.state.routes = this.state.routes.filter(item => item.id !== id)
    if (this.state.routes.length === before) return false
    await this.save()
    return true
  }

  /**
   * Create or update one hand-written Caddy snippet.
   * @param {Record<string, any>} input - snippet fields.
   * @returns {Promise<Record<string, any>>} the stored snippet.
   */
  async upsertSnippet(input) {
    const id = String(input.id ?? slug(input.name ?? 'snippet'))
    const next = normalizeSnippet({ id, name: input.name, content: input.content, order: input.order })
    const index = this.state.snippets.findIndex(item => item.id === id)
    if (index >= 0) this.state.snippets[index] = next
    else this.state.snippets.push(next)
    this.state.snippets.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    await this.save()
    return next
  }

  /**
   * Remove one snippet.
   * @param {string} id - snippet id.
   * @returns {Promise<boolean>} whether a row was removed.
   */
  async removeSnippet(id) {
    const before = this.state.snippets.length
    this.state.snippets = this.state.snippets.filter(item => item.id !== id)
    if (this.state.snippets.length === before) return false
    await this.save()
    return true
  }

  /**
   * Merge settings and persist.
   * @param {Record<string, any>} patch - settings to change.
   * @returns {Promise<Record<string, any>>} the stored settings.
   */
  async updateSettings(patch) {
    const next = { ...this.state.settings }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] === undefined) continue
      next[key] = patch[key]
    }
    next.proxyListen = normalizeListen(next.proxyListen)
    next.adminEndpoint = String(next.adminEndpoint || DEFAULT_SETTINGS.adminEndpoint)
    next.caddyExe = String(next.caddyExe || DEFAULT_SETTINGS.caddyExe)
    next.autoStartCaddy = next.autoStartCaddy !== false
    next.caddyBootMode = next.caddyBootMode === 'none' ? 'none' : 'script'
    next.trustProxyHeaders = next.trustProxyHeaders !== false
    this.state.settings = next
    await this.save()
    return next
  }

  /**
   * Switch between generated and hand-written Caddy configuration.
   * @param {'managed' | 'manual'} mode - target mode.
   * @returns {Promise<void>} resolves after saving.
   */
  async setCaddyMode(mode) {
    this.state.caddy = { mode: mode === 'manual' ? 'manual' : 'managed' }
    await this.save()
  }
}

/**
 * Coerce a listen address into Caddy's `:port` or `host:port` form.
 * @param {unknown} value - raw value.
 * @returns {string} normalized listen address.
 */
export function normalizeListen(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return DEFAULT_SETTINGS.proxyListen
  if (/^\d+$/.test(text)) return `:${text}`
  if (/^[A-Za-z0-9_.\-]+$/.test(text) && !text.includes('.')) return `:${text}`
  return text
}

/**
 * Normalize one service row so stored and tool-provided shapes agree.
 * @param {Record<string, any>} raw - incoming row.
 * @returns {Record<string, any>} canonical service.
 */
export function normalizeService(raw = {}) {
  const autoStart = raw.autoStart === 'boot' || raw.autoStart === 'dsh' ? raw.autoStart : 'none'
  const manage = raw.manage === 'external' ? 'external' : 'process'
  const env = {}
  if (raw.env && typeof raw.env === 'object') {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof key !== 'string' || key.length === 0) continue
      if (typeof value !== 'string' && typeof value !== 'number') continue
      env[key] = String(value)
    }
  }
  const port = Number(raw.port)
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? raw.id ?? 'service'),
    description: String(raw.description ?? ''),
    cwd: String(raw.cwd ?? ''),
    command: String(raw.command ?? ''),
    env,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    healthPath: String(raw.healthPath ?? ''),
    autoStart,
    manage,
    createdAt: String(raw.createdAt ?? nowIso()),
    updatedAt: String(raw.updatedAt ?? nowIso()),
  }
}

/**
 * Normalize one route row.
 * @param {Record<string, any>} raw - incoming row.
 * @returns {Record<string, any>} canonical route.
 */
export function normalizeRoute(raw = {}) {
  const kind = raw.kind === 'redirect' || raw.kind === 'static' ? raw.kind : 'proxy'
  const match = {
    path: normalizePath(raw.path ?? raw.match?.path ?? '/'),
    exact: Boolean(raw.exact ?? raw.match?.exact),
    host: String(raw.host ?? raw.match?.host ?? ''),
  }
  const authType = raw.auth?.type === 'basic' ? 'basic' : 'none'
  const auth = {
    type: authType,
    user: String(raw.auth?.user ?? ''),
    hash: String(raw.auth?.hash ?? ''),
  }
  const headerUp = {}
  const rawHeaders = raw.headerUp && typeof raw.headerUp === 'object' ? raw.headerUp : {}
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === 'string' || typeof value === 'number') headerUp[String(key)] = String(value)
  }
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? raw.id ?? 'route'),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
    enabled: raw.enabled !== false,
    kind,
    match,
    stripPrefix: raw.stripPrefix === true,
    upstream: String(raw.upstream ?? ''),
    headerUp,
    auth,
    cors: raw.cors === true,
    redirect: {
      to: String(raw.redirect?.to ?? raw.to ?? ''),
      code: Number(raw.redirect?.code ?? raw.code ?? 308),
    },
    static: {
      root: String(raw.static?.root ?? raw.root ?? ''),
      rewrite: String(raw.static?.rewrite ?? raw.rewrite ?? ''),
    },
    raw: typeof raw.raw === 'string' && raw.raw.trim().length > 0 ? raw.raw : '',
    createdAt: String(raw.createdAt ?? nowIso()),
    updatedAt: String(raw.updatedAt ?? nowIso()),
  }
}

/**
 * Normalize a path matcher value.
 * @param {unknown} value - raw path.
 * @returns {string} a leading-slash path.
 */
export function normalizePath(value) {
  const text = String(value ?? '/').trim()
  if (text.length === 0) return '/'
  return text.startsWith('/') ? text : `/${text}`
}

/**
 * Normalize a hand-written snippet.
 * @param {Record<string, any>} raw - incoming snippet.
 * @returns {Record<string, any>} canonical snippet.
 */
export function normalizeSnippet(raw = {}) {
  return {
    id: String(raw.id ?? 'snippet'),
    name: String(raw.name ?? raw.id ?? 'snippet'),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
    content: String(raw.content ?? ''),
  }
}
