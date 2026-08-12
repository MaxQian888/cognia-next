import { discoverCodexRenderer } from "./cdp-bootstrap.mjs"
import { scheduleDetachedCdpRelaunch } from "./cdp-relaunch.mjs"
import { inspectTcpListener } from "./listener-safety.mjs"
import { APP_PATH, DEFAULT_REAL_CLI, appProcessIds, commandResult, waitFor } from "./shared.mjs"

function defaultAppServerChildren({ appPids, realCli }) {
  const owners = new Set(appPids)
  const listed = commandResult("/bin/ps", ["-axo", "pid=,ppid=,command="])
  if (!listed.ok) throw new Error(listed.stderr || listed.error || "Unable to inspect App children")
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => {
      const command = match?.[3] ?? ""
      return (
        owners.has(Number(match?.[2])) &&
        command.startsWith(
          `${realCli} -c features.code_mode_host=true app-server --analytics-default-enabled`
        ) &&
        !command.includes("--listen") &&
        !command.includes("relay-shim")
      )
    })
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
}

async function inspectRuntime(cdpPort, realCli, dependencies) {
  const pids = dependencies.appProcessIds()
  const listener = dependencies.inspectTcpListener(cdpPort)
  let renderer = null
  let rendererError = null
  try {
    renderer = await dependencies.discoverCodexRenderer(cdpPort)
  } catch (error) {
    rendererError = error instanceof Error ? error.message : String(error)
  }
  const appServerChildren =
    pids.length === 1 ? dependencies.normalAppServerChildren({ appPids: pids, realCli }) : []
  return {
    ready:
      pids.length === 1 &&
      listener.loopbackOnly &&
      Boolean(renderer) &&
      appServerChildren.length === 1,
    pids,
    listener,
    renderer,
    rendererError,
    appServerChildren,
  }
}

export async function ensureCodexCdpRuntime(options = {}, injected = {}) {
  const cdpPort = options.cdpPort ?? 9229
  const appPath = options.appPath ?? APP_PATH
  const realCli = options.realCli ?? DEFAULT_REAL_CLI
  const stateDir = options.stateDir
  const timeoutMs = options.timeoutMs ?? 60_000
  const autoRestart = options.autoRestart !== false
  const onStatus = async (status, details = {}) => options.onStatus?.(status, details)
  const dependencies = {
    appProcessIds,
    commandResult,
    discoverCodexRenderer,
    inspectTcpListener,
    normalAppServerChildren: defaultAppServerChildren,
    relaunchCdpApp: scheduleDetachedCdpRelaunch,
    waitFor,
    ...injected,
  }

  await onStatus("checking", { cdpPort })
  const initial = await inspectRuntime(cdpPort, realCli, dependencies)
  if (initial.ready) {
    await onStatus("ready", { restarted: false, ...initial })
    return { ...initial, restarted: false }
  }
  if (initial.pids.length > 1) {
    throw new Error(`Expected at most one Codex App process, found ${initial.pids.length}`)
  }
  if (initial.listener.listening) {
    const reason = initial.listener.loopbackOnly
      ? `CDP port 127.0.0.1:${cdpPort} is occupied but does not expose a Codex renderer`
      : `CDP port ${cdpPort} is not loopback-only`
    throw new Error(reason)
  }
  if (!autoRestart) {
    throw new Error(
      `Codex App does not expose loopback CDP on 127.0.0.1:${cdpPort}; automatic restart is disabled`
    )
  }

  await onStatus("restart-required", {
    cdpPort,
    currentAppPids: initial.pids,
    rendererError: initial.rendererError,
  })
  try {
    await onStatus("restart-armed", { cdpPort })
    const relaunch = await dependencies.relaunchCdpApp({
      cdpPort,
      appPath,
      realCli,
      stateDir,
      timeoutMs: Math.max(timeoutMs + 180_000, 240_000),
      delaySeconds: 0,
    })
    await onStatus("waiting-for-runtime", { cdpPort, timeoutMs })
    const ready = await dependencies.waitFor(
      async () => {
        const runtime = await inspectRuntime(cdpPort, realCli, dependencies)
        if (runtime.listener.listening && !runtime.listener.loopbackOnly) {
          throw new Error(`CDP listener on port ${cdpPort} is not loopback-only`)
        }
        return runtime.ready ? runtime : null
      },
      {
        timeoutMs,
        intervalMs: 250,
        description: "Codex renderer, loopback CDP, and normal App-owned runtime",
      }
    )
    await onStatus("ready", { restarted: true, relaunch, ...ready })
    return { ...ready, restarted: true, relaunch }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await onStatus("recovery-failed", { error: message })
    throw error
  }
}
