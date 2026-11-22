/**
 * Process supervisor for declared services.
 *
 * The manager owns every process it starts (they die with the plugin), and it
 * can also report and stop processes it did not start by looking up whoever is
 * listening on the declared port. That is what lets an externally started
 * service be adopted without a restart.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  attachProcessLog,
  ensureDir,
  expandEnv,
  isPortListening,
  killTree,
  nowIso,
  pidOnPort,
  tailLines,
} from './util.js'

/** Keep the last N log lines in memory for fast panel reads. */
const BUFFER_LINES = 300

/** Supervises declared services. */
export class Supervisor {
  /**
   * @param {import('./store.js').Store} store - registry store.
   */
  constructor(store) {
    this.store = store
    /** @type {Map<string, {child: import('node:child_process').ChildProcess, startedAt: number}>} */
    this.procs = new Map()
    /** @type {Map<string, {code: number | null, at: string}>} */
    this.exits = new Map()
    /** @type {Map<string, string[]>} */
    this.buffers = new Map()
    /** @type {Map<string, import('node:fs').WriteStream>} */
    this.streams = new Map()
  }

  /**
   * Log file for one service.
   * @param {string} id - service id.
   * @returns {string} absolute path.
   */
  logFile(id) {
    return path.join(this.store.dirs.logs, `${id}.log`)
  }

  /**
   * Describe one service plus its live process state.
   * @param {Record<string, any>} service - stored service.
   * @returns {Promise<Record<string, any>>} the live view.
   */
  async status(service) {
    const rec = this.procs.get(service.id)
    const tracked = rec !== undefined && rec.child.exitCode === null
    const portPid = service.port ? await pidOnPort(service.port) : undefined
    const running = tracked || portPid !== undefined
    const pid = tracked ? rec.child.pid : portPid
    const health = running && service.port && service.healthPath
      ? await this.health(service)
      : undefined
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      cwd: service.cwd,
      command: service.command,
      env: service.env,
      port: service.port,
      healthPath: service.healthPath,
      autoStart: service.autoStart,
      manage: service.manage,
      running,
      owned: tracked,
      pid,
      uptimeMs: tracked ? Date.now() - rec.startedAt : undefined,
      portListening: portPid !== undefined,
      health,
      lastExit: this.exits.get(service.id),
    }
  }

  /**
   * Live view of every declared service.
   * @returns {Promise<Array<Record<string, any>>>} status rows.
   */
  async snapshot() {
    const rows = []
    for (const service of this.store.services) rows.push(await this.status(service))
    return rows
  }

  /**
   * Probe an HTTP health endpoint.
   * @param {Record<string, any>} service - stored service.
   * @returns {Promise<{ok: boolean, status?: number, error?: string}>} the probe result.
   */
  async health(service) {
    const route = service.healthPath.startsWith('/') ? service.healthPath : `/${service.healthPath}`
    const url = `http://127.0.0.1:${service.port}${route}`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Start one service.
   * @param {string} id - service id.
   * @returns {Promise<{ok: boolean, output: string, status?: Record<string, any>}>} the outcome.
   */
  async start(id) {
    const service = this.store.service(id)
    if (!service) return { ok: false, output: `unknown service: ${id}` }
    if (service.manage === 'external') {
      return { ok: false, output: 'this service is marked external: start it with its own tool' }
    }
    const rec = this.procs.get(id)
    if (rec && rec.child.exitCode === null) {
      return { ok: true, output: `already running (pid ${rec.child.pid})`, status: await this.status(service) }
    }
    if (service.port && (await isPortListening(service.port))) {
      const pid = await pidOnPort(service.port)
      return {
        ok: false,
        output: `port ${service.port} is already in use by pid ${pid}; stop it first or mark the service external`,
        status: await this.status(service),
      }
    }
    const cwd = service.cwd ? path.resolve(expandEnv(service.cwd)) : this.store.dataDir
    const command = expandEnv(service.command)
    await ensureDir(this.store.dirs.logs)
    const stream = createWriteStream(this.logFile(id), { flags: 'a' })
    this.streams.set(id, stream)

    let child
    try {
      child = spawn(command, [], {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...service.env },
      })
    } catch (error) {
      stream.end()
      this.streams.delete(id)
      return { ok: false, output: `spawn failed: ${String(error)}` }
    }
    const buffer = []
    this.buffers.set(id, buffer)
    const log = attachProcessLog(child, stream, {
      onData: text => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length === 0) continue
          buffer.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
          if (buffer.length > BUFFER_LINES) buffer.shift()
        }
      },
    })
    log.write(`\n=== ${nowIso()} start: ${command} (cwd ${cwd}) ===\n`)
    child.on('exit', code => {
      this.exits.set(id, { code, at: nowIso() })
      this.procs.delete(id)
      this.streams.delete(id)
    })
    this.procs.set(id, { child, startedAt: Date.now() })

    // Give the process a moment to fail fast (bad interpreter, missing cwd).
    await new Promise(resolve => setTimeout(resolve, 700))
    const after = this.procs.get(id)
    if (!after || after.child.exitCode !== null || after.child.pid === undefined) {
      const exit = this.exits.get(id)
      return {
        ok: false,
        output: `process exited immediately (code ${exit?.code ?? 'unknown'}); see logs/${id}.log`,
        status: await this.status(service),
      }
    }
    return {
      ok: true,
      output: `started (pid ${after.child.pid})`,
      status: await this.status(service),
    }
  }

  /**
   * Stop one service, whether or not this plugin started it.
   * @param {string} id - service id.
   * @returns {Promise<{ok: boolean, output: string, status?: Record<string, any>}>} the outcome.
   */
  async stop(id) {
    const service = this.store.service(id)
    if (!service) return { ok: false, output: `unknown service: ${id}` }
    const rec = this.procs.get(id)
    const trackedAlive = rec !== undefined && rec.child.exitCode === null
    const pid = trackedAlive ? rec.child.pid : (service.port ? await pidOnPort(service.port) : undefined)
    if (!pid) return { ok: true, output: 'not running', status: await this.status(service) }
    const killed = await killTree(pid)
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 250))
      const still = trackedAlive
        ? this.procs.get(id)?.child.exitCode === null
        : await isPortListening(service.port)
      if (!still) break
    }
    return {
      ok: killed.ok,
      output: killed.ok ? `stopped pid ${pid}` : `taskkill failed: ${killed.output}`,
      status: await this.status(service),
    }
  }

  /**
   * Restart one service.
   * @param {string} id - service id.
   * @returns {Promise<{ok: boolean, output: string, status?: Record<string, any>}>} the outcome.
   */
  async restart(id) {
    const stopped = await this.stop(id)
    if (!stopped.ok) return stopped
    await new Promise(resolve => setTimeout(resolve, 400))
    return this.start(id)
  }

  /**
   * Read the tail of a service log.
   * @param {string} id - service id.
   * @param {number} [lines] - how many lines.
   * @returns {Promise<{lines: string[], source: 'memory' | 'file'}>} the tail.
   */
  async logs(id, lines = 120) {
    const buffered = this.buffers.get(id)
    if (buffered && buffered.length > 0) {
      return { lines: buffered.slice(-Math.max(1, Math.min(BUFFER_LINES, lines))), source: 'memory' }
    }
    return { lines: await tailLines(this.logFile(id), lines), source: 'file' }
  }

  /**
   * Start every service whose auto-start scope matches.
   * @param {'dsh' | 'boot'} scope - which scope to start.
   * @returns {Promise<Array<{id: string, ok: boolean, output: string}>>} per-service outcomes.
   */
  async startAuto(scope) {
    const results = []
    for (const service of this.store.services) {
      if (service.autoStart !== scope) continue
      if (service.manage === 'external') continue
      results.push({ id: service.id, ...(await this.start(service.id)) })
    }
    return results
  }

  /**
   * Stop every child this plugin owns.
   * @returns {Promise<void>} resolves after best-effort termination.
   */
  async shutdown() {
    const pids = []
    for (const [, rec] of this.procs) {
      if (rec.child.exitCode === null && rec.child.pid) pids.push(rec.child.pid)
    }
    for (const pid of pids) await killTree(pid).catch(() => {})
    for (const [, stream] of this.streams) {
      try {
        stream.end()
      } catch {
        /* already ended */
      }
    }
    this.procs.clear()
    this.streams.clear()
  }
}
