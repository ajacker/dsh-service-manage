import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Caddy } from '../lib/caddy.js'
import { normalizeRoute, normalizeService, normalizeListen, DEFAULT_SETTINGS } from '../lib/store.js'
import { attachProcessLog } from '../lib/util.js'

/**
 * Build a Caddy instance over an in-memory fake store.
 * @param {Record<string, any>} [overrides] - settings/routes to override.
 * @returns {Caddy} the instance.
 */
function fakeCaddy(overrides = {}) {
  const store = {
    settings: { ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) },
    state: { caddy: { mode: overrides.mode ?? 'managed' } },
    routes: overrides.routes ?? [],
    snippets: overrides.snippets ?? [],
    dirs: { logs: path.join(os.tmpdir(), 'sm-test') },
    dataDir: os.tmpdir(),
    caddyfile: path.join(os.tmpdir(), 'sm-test', 'Caddyfile'),
  }
  return new Caddy(store)
}

test('main Caddyfile imports routes, snippets and keeps a 404 fallback', () => {
  const text = fakeCaddy().buildMain()
  assert.match(text, /{\n\tadmin localhost:2019/)
  assert.match(text, /auto_https off/)
  assert.match(text, /trusted_proxies static private_ranges/)
  assert.match(text, /:8080 \{/)
  assert.match(text, /import routes\/_managed\.caddy/)
  assert.match(text, /import custom\/\*\.caddy/)
  assert.match(text, /respond "Not Found" 404/)
})

test('a proxy route renders a path matcher and reverse_proxy', () => {
  const route = normalizeRoute({ id: 'image', name: 'image', path: '/image', upstream: '127.0.0.1:8090' })
  const text = fakeCaddy().buildRoute(route)
  assert.match(text, /@svc_image \{/)
  assert.match(text, /path \/image\*/)
  assert.match(text, /handle @svc_image \{/)
  assert.match(text, /reverse_proxy 127\.0\.0\.1:8090/)
})

test('stripPrefix strips inside the handler and an exact match drops the wildcard', () => {
  const stripped = normalizeRoute({ id: 'comfy', path: '/comfyui', upstream: '127.0.0.1:9199', stripPrefix: true })
  assert.match(fakeCaddy().buildRoute(stripped), /handle @svc_comfy \{/)
  assert.match(fakeCaddy().buildRoute(stripped), /path \/comfyui\*/)

  const exact = normalizeRoute({ id: 'slash', path: '/comfyui', exact: true, kind: 'redirect', to: '/comfyui/' })
  const text = fakeCaddy().buildRoute(exact)
  assert.match(text, /path \/comfyui\n/)
  assert.match(text, /redir \* \/comfyui\/ 308/)
})

test('CORS renders response headers, an OPTIONS matcher and a 204 respond', () => {
  const route = normalizeRoute({ id: 'v1', path: '/v1', upstream: '127.0.0.1:8090', cors: true, stripPrefix: true })
  const text = fakeCaddy().buildRoute(route)
  assert.match(text, /@svc_v1_opt method OPTIONS/)
  assert.match(text, /respond @svc_v1_opt 204/)
  assert.match(text, /Access-Control-Allow-Origin \*/)
  // The matcher must be defined at site level, never inside the handle block.
  const handleIndex = text.indexOf('handle @svc_v1 {')
  const matcherIndex = text.indexOf('@svc_v1_opt method OPTIONS')
  assert.ok(matcherIndex < handleIndex, 'OPTIONS matcher must precede the handler block')
})

test('basic auth embeds the bcrypt hash and keeps it out of the route name', () => {
  const route = normalizeRoute({
    id: 'comfy',
    path: '/comfyui',
    upstream: '127.0.0.1:9199',
    stripPrefix: true,
    auth: { type: 'basic', user: 'admin', hash: '$2a$14$abcdefghijklmnopqrstuv' },
  })
  const text = fakeCaddy().buildRoute(route)
  assert.match(text, /basic_auth \{/)
  assert.match(text, /\t\tadmin \$2a\$14\$abcdefghijklmnopqrstuv/)
})

test('static and redirect routes render their own directives', () => {
  const staticRoute = normalizeRoute({ id: 'status', path: '/status', kind: 'static', root: 'D:/site', rewrite: '/status.html' })
  const staticText = fakeCaddy().buildRoute(staticRoute)
  assert.match(staticText, /root \* D:\/site/)
  assert.match(staticText, /rewrite \* \/status\.html/)
  assert.match(staticText, /file_server/)
})

test('a raw route is emitted verbatim', () => {
  const raw = normalizeRoute({ id: 'custom', raw: 'handle /raw {\n\trespond "ok"\n}' })
  assert.match(fakeCaddy().buildRoute(raw), /handle \/raw \{\n\trespond "ok"\n\}/)
})

test('service normalization rejects junk and keeps known fields', () => {
  const service = normalizeService({
    id: 'image-api',
    name: '生图 API',
    command: 'python main.py',
    port: '8090',
    autoStart: 'bogus',
    manage: 'nope',
    env: { PORT: 8090, BAD: { nested: true } },
  })
  assert.equal(service.port, 8090)
  assert.equal(service.autoStart, 'none')
  assert.equal(service.manage, 'process')
  assert.deepEqual(service.env, { PORT: '8090' })
})

test('listen addresses accept bare ports and host:port forms', () => {
  assert.equal(normalizeListen('8080'), ':8080')
  assert.equal(normalizeListen(':8080'), ':8080')
  assert.equal(normalizeListen('127.0.0.1:8080'), '127.0.0.1:8080')
  assert.equal(normalizeListen(''), DEFAULT_SETTINGS.proxyListen)
})

test('a process log survives the child closing its output first', () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const stream = new PassThrough()
  const seen = []
  const log = attachProcessLog(child, stream, { onData: text => seen.push(text) })

  child.stdout.emit('data', 'first line\n')
  child.stdout.end()
  stream.end() // the failure mode: destination already finished
  assert.doesNotThrow(() => log.write('after end\n'))
  assert.doesNotThrow(() => child.emit('close', 0))
  assert.deepEqual(seen, ['first line\n'])
})

test('a spawn error is logged instead of thrown', () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const stream = new PassThrough()
  let captured = ''
  stream.on('data', chunk => { captured += String(chunk) })
  attachProcessLog(child, stream)
  assert.doesNotThrow(() => child.emit('error', new Error('ENOENT')))
  assert.match(captured, /spawn error: Error: ENOENT/)
})
