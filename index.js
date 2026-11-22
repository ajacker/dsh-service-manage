/**
 * dsh-service-manage — host half.
 *
 * Owns three things for the running DSH process: the declarative registry of
 * local services, the supervisor that starts and stops them, and the Caddy
 * reverse proxy whose configuration the panel and the agent tools edit.
 *
 * On activation it restores the managed Caddyfile, serves the panel API on
 * `/service-manage`, registers the tools, and starts whatever is marked to
 * follow DSH. On disposal it stops the children it owns.
 */
import { Caddy } from './lib/caddy.js'
import { Supervisor } from './lib/services.js'
import { Store, resolveDataDir } from './lib/store.js'
import { createApiHandler } from './lib/api.js'
import { registerTools } from './lib/tools.js'

/** Service dependencies this plugin needs. */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** Prompt section that tells the agent how the manager is meant to be used. */
const PROMPT = [
  '## Local services and reverse proxy',
  'A service-manager plugin owns local processes, their ports, and the Caddy reverse proxy.',
  '- Read the current state with `service_status` before changing anything, and call it again to verify the result.',
  '- `service_control` starts, stops, and restarts one service and reads its log.',
  '- `service_config` edits the service registry; `proxy_route` edits structured reverse-proxy routes.',
  '- Route and snippet changes regenerate the Caddyfile, validate it, then reload Caddy. A validation failure rolls the files back, so report the returned error instead of retrying blindly.',
  '- `caddy_config` reads or replaces the whole Caddyfile and validates/reloads it. Writing the file switches Caddy to manual mode, where structured routes stop being rendered.',
].join('\n')

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - row config from the bundle patch.
 * @returns {Promise<void>} resolves once the API and tools are registered.
 */
export async function apply(ctx, config = {}) {
  const store = new Store({ dataDir: resolveDataDir(config), config })
  await store.load()
  const supervisor = new Supervisor(store)
  const caddy = new Caddy(store)

  if (store.state.caddy.mode === 'managed') {
    await caddy.render()
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/service-manage',
    handler: createApiHandler({ store, supervisor, caddy }),
  }), 'service-manage: api route')

  registerTools(ctx, { store, supervisor, caddy })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'service-manage:policy',
    order: 60,
    text: PROMPT,
  }), 'service-manage: prompt section')

  let bootTimer
  ctx.effect(() => () => {
    if (bootTimer) clearTimeout(bootTimer)
    void supervisor.shutdown().catch(() => {})
    void caddy.dispose().catch(() => {})
  }, 'service-manage: process cleanup')

  // Startup work must not block or fail activation: a missing Caddy or a busy
  // port is reported by the panel, not raised into the plugin loader. Caddy is
  // started only when the setting is on, so installing the plugin can never
  // take over a port another proxy already serves. Services marked "boot" start
  // after a short delay, and an already listening port counts as started, so a
  // login launcher that is binding the same port wins instead of colliding.
  void (async () => {
    try {
      if (store.settings.autoStartCaddy === true) {
        const status = await caddy.status(600)
        if (!status.reachable) await caddy.start()
      }
    } catch {
      /* reported by the panel */
    }
    try {
      await supervisor.startAuto(['dsh'])
    } catch {
      /* reported by the panel */
    }
    const timer = setTimeout(() => {
      void supervisor.startAuto(['boot']).catch(() => {})
    }, 6000)
    bootTimer = timer
    timer.unref?.()
  })()
}
