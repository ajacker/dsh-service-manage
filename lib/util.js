/**
 * Small shared helpers for the service manager: filesystem, process execution,
 * port observation and log tailing. Node built-ins only, so the bundle needs no
 * dependency of its own.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, appendFile, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import os from 'node:os'

export const isWindows = process.platform === 'win32'

/** @returns {string} current time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Create a directory recursively, ignoring an existing one.
 * @param {string} dir - directory to create.
 * @returns {Promise<void>} resolves once the directory exists.
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * Read and parse a JSON file.
 * @param {string} file - absolute path.
 * @param {unknown} fallback - value returned when the file does not exist.
 * @returns {Promise<any>} the parsed value or the fallback.
 */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * @param {string} file - absolute path.
 * @param {string} text - contents.
 * @returns {Promise<void>} resolves once the rename completed.
 */
export async function writeFileAtomic(file, text) {
  await ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/**
 * Append text to a file.
 * @param {string} file - absolute path.
 * @param {string} text - contents to append.
 * @returns {Promise<void>} resolves after the write.
 */
export async function appendLog(file, text) {
  await ensureDir(dirname(file))
  await appendFile(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
}

/**
 * Run a command and capture its output instead of throwing on a non-zero exit.
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @param {{cwd?: string, timeout?: number, env?: Record<string, string>}} [options] - spawn options.
 * @returns {Promise<{code: number, stdout: string, stderr: string, error?: Error}>} the settled result.
 */
export function run(file, args, options = {}) {
  const { cwd, timeout = 20000, env } = options
  return new Promise(resolve => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error ? { error } : {}),
        })
      },
    )
  })
}

/**
 * Spawn a detached-ish child whose output is captured; used for the Caddy process.
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @param {{cwd?: string}} [options] - extra spawn options.
 * @returns {import('node:child_process').ChildProcess} the child process.
 */
export function spawnCaptured(file, args, options = {}) {
  return spawn(file, args, {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

/**
 * Pipe a child's output into a log stream without ever throwing.
 *
 * `child.stdout.pipe(stream)` ends the destination when the child closes its
 * stdout, so a later `stream.write()` in an exit handler raised
 * ERR_STREAM_WRITE_AFTER_END and took the whole host down. This helper keeps the
 * destination open, writes only while it is writable, and closes it on `close`.
 * @param {import('node:child_process').ChildProcess} child - spawned process.
 * @param {import('node:fs').WriteStream} stream - log destination.
 * @param {{onData?: (text: string) => void}} [options] - observer for captured text.
 * @returns {{write: (text: string) => void}} a guarded writer for extra lines.
 */
export function attachProcessLog(child, stream, options = {}) {
  const write = text => {
    try {
      if (stream.writable && !stream.destroyed) stream.write(text)
    } catch {
      /* the destination is gone; losing one log line must never throw */
    }
  }
  stream.on('error', () => {})
  const onData = chunk => {
    const text = String(chunk)
    write(text)
    try {
      options.onData?.(text)
    } catch {
      /* observer failures are not the host's problem */
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', error => write(`spawn error: ${String(error)}\n`))
  child.on('close', code => {
    write(`=== ${nowIso()} exited (${code}) ===\n`)
    try {
      stream.end()
    } catch {
      /* already ended */
    }
  })
  return { write }
}

/**
 * Expand `%VAR%` (Windows form) and `$VAR` references against the current
 * environment, so a stored command can carry `%LOCALAPPDATA%` style paths.
 * @param {string} text - raw text.
 * @returns {string} text with known variables substituted.
 */
export function expandEnv(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    .replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
    .replace(/\$\{([^}]+)\}/g, (whole, name) => process.env[name] ?? whole)
}

/** @type {{at: number, listeners: Map<number, number[]>}} */
let listenCache = { at: 0, listeners: new Map() }

/**
 * Map every TCP listening port to the process ids bound to it. Cached for just
 * over a second so a status poll does not spawn one `netstat` per service.
 * @param {boolean} [force] - ignore the cache.
 * @returns {Promise<Map<number, number[]>>} port to pids.
 */
export async function listeningPorts(force = false) {
  if (!isWindows) return new Map()
  const now = Date.now()
  if (!force && now - listenCache.at < 1200) return listenCache.listeners
  const result = await run('netstat', ['-ano', '-p', 'tcp'], { timeout: 8000 })
  const listeners = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0] !== 'TCP') continue
    if (!/LISTENING/i.test(parts[3])) continue
    const local = parts[1]
    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const port = Number(local.slice(colon + 1))
    const pid = Number(parts[4])
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue
    const pids = listeners.get(port) ?? []
    if (!pids.includes(pid)) pids.push(pid)
    listeners.set(port, pids)
  }
  listenCache = { at: now, listeners }
  return listeners
}

/**
 * Find the process currently listening on one port.
 * @param {number} port - TCP port.
 * @returns {Promise<number | undefined>} the owning pid.
 */
export async function pidOnPort(port) {
  if (!Number.isInteger(port) || port <= 0) return undefined
  const map = await listeningPorts()
  return map.get(port)?.[0]
}

/**
 * Test whether a TCP port currently has a listener.
 * @param {number} port - TCP port.
 * @returns {Promise<boolean>} true when something listens on it.
 */
export async function isPortListening(port) {
  return (await pidOnPort(port)) !== undefined
}

/**
 * Terminate a process and its children.
 * @param {number} pid - process id.
 * @returns {Promise<{ok: boolean, output: string}>} the kill outcome.
 */
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, output: 'invalid pid' }
  if (isWindows) {
    const result = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 })
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
  }
  try {
    process.kill(pid, 'SIGTERM')
    return { ok: true, output: `SIGTERM ${pid}` }
  } catch (error) {
    return { ok: false, output: String(error) }
  }
}

/**
 * Test whether the current process can register a Windows service.
 * @returns {Promise<boolean>} true when the process is elevated.
 */
export async function isElevated() {
  if (!isWindows) return false
  const result = await run('net', ['session'], { timeout: 5000 })
  return result.code === 0
}

/**
 * Read the tail of a text file without loading the whole file.
 * @param {string} file - absolute path.
 * @param {number} [lines] - how many lines to return.
 * @returns {Promise<string[]>} the requested trailing lines.
 */
export async function tailLines(file, lines = 120) {
  const wanted = Math.max(1, Math.min(2000, Number(lines) || 120))
  let handle
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat()
    const readBytes = Math.min(stat.size, Math.max(16 * 1024, wanted * 400))
    const buffer = Buffer.alloc(readBytes)
    await handle.read(buffer, 0, readBytes, stat.size - readBytes)
    const text = buffer.toString('utf8')
    const all = text.split(/\r?\n/)
    if (readBytes < stat.size) all.shift()
    return all.slice(-wanted)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  } finally {
    await handle?.close()
  }
}

/**
 * Normalize a user-supplied identifier into a stable slug.
 * @param {string} input - raw name or id.
 * @param {string} [fallback] - used when nothing usable remains.
 * @returns {string} the slug.
 */
export function slug(input, fallback = 'item') {
  const text = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return text.length > 0 ? text.slice(0, 48) : `${fallback}-${Date.now().toString(36).slice(-4)}`
}

/**
 * Quote one Caddyfile argument when it contains characters Caddy would split.
 * @param {string} value - raw value.
 * @returns {string} a safely quoted token.
 */
export function caddyQuote(value) {
  const text = String(value ?? '')
  if (text.length === 0) return '""'
  if (/^[A-Za-z0-9_./:*@%$+\-]+$/.test(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Test whether a value addresses this machine's loopback interface.
 * @param {string | undefined} remoteAddress - socket peer address.
 * @returns {boolean} true for 127.0.0.0/8 and ::1 forms.
 */
export function isLoopbackAddress(remoteAddress) {
  const address = String(remoteAddress ?? '')
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    /^127\./.test(address) ||
    /^::ffff:127\./.test(address)
  )
}

/** @returns {string} the user's home directory. */
export function homeDir() {
  return os.homedir()
}
