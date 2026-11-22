/**
 * Switching one entry between the two autostart mechanisms: the hidden login
 * launcher (registry + start-all.cmd) and a real Windows service.
 *
 * Both directions keep the system coherent: the currently running process is
 * stopped before a service takes the port, and the login script is regenerated
 * afterwards so exactly one mechanism owns each entry.
 */
import { run } from './util.js'
import { serviceState, serviceName, registerWindowsService, unregisterWindowsService, caddyServicePlan, installService, removeService, writeAutostartScripts } from './windows.js'

/**
 * Switch one declared service between login-script and Windows-service autostart.
 * @param {{store: import('./store.js').Store, supervisor: import('./services.js').Supervisor}} deps - runtime.
 * @param {Record<string, any>} service - stored service.
 * @param {'script' | 'service'} mode - target mechanism.
 * @returns {Promise<Record<string, any>>} the outcome plus the new mode.
 */
export async function setServiceBootMode({ store, supervisor }, service, mode) {
  if (mode === 'service') {
    const current = await serviceState(serviceName(service.id), true)
    if (!current.exists) {
      // The service needs the port free before it can start.
      if (service.port && (await supervisor.status(service)).portListening) {
        await supervisor.stop(service.id)
      }
      const result = await registerWindowsService(store, service)
      if (!result.ok) {
        await supervisor.start(service.id, { adopt: true }).catch(() => {})
        return { mode: 'script', result }
      }
    } else if (current.status !== 'running') {
      await run('sc', ['start', serviceName(service.id)], { timeout: 30000 })
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    await writeAutostartScripts(store)
    return { mode: 'service', result: { ok: true, output: `Windows service ${serviceName(service.id)} is running` } }
  }
  const current = await serviceState(serviceName(service.id), true)
  let result = { ok: true, output: 'no Windows service installed' }
  if (current.exists) result = await unregisterWindowsService(store, service)
  await writeAutostartScripts(store)
  if (result.ok) await supervisor.start(service.id, { adopt: true }).catch(() => {})
  return { mode: 'script', result }
}

/**
 * Switch the reverse proxy between login-script and Windows-service autostart.
 * @param {{store: import('./store.js').Store, caddy: import('./caddy.js').Caddy}} deps - runtime.
 * @param {'script' | 'service'} mode - target mechanism.
 * @returns {Promise<Record<string, any>>} the outcome plus the new mode.
 */
export async function setCaddyBootMode({ store, caddy }, mode) {
  const plan = await caddyServicePlan(store)
  const current = await serviceState(plan.name, true)
  if (mode === 'service') {
    if (!current.exists) {
      await caddy.stop()
      const result = await installService(plan, 'Caddy')
      if (!result.ok) {
        await caddy.start()
        return { mode: 'script', result }
      }
      await waitForProxy(caddy)
    } else if (current.status !== 'running') {
      await run('sc', ['start', plan.name], { timeout: 30000 })
      await waitForProxy(caddy)
    }
    await writeAutostartScripts(store)
    return { mode: 'service', result: { ok: true, output: `Windows service ${plan.name} is running` } }
  }
  let result = { ok: true, output: 'no Windows service installed' }
  if (current.exists) result = await removeService(plan, 'Caddy')
  await writeAutostartScripts(store)
  if (result.ok) await caddy.start()
  return { mode: 'script', result }
}

/**
 * Wait until the proxy answers on its admin endpoint.
 * @param {import('./caddy.js').Caddy} caddy - controller.
 * @param {number} [timeout] - milliseconds to wait.
 * @returns {Promise<boolean>} true when it came up.
 */
export async function waitForProxy(caddy, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await caddy.status(500)).reachable) return true
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
}
