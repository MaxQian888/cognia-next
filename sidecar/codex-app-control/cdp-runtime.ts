import { discoverCodexRenderer } from "./cdp-bootstrap.ts"
import type { CdpTarget } from "./cdp-bootstrap.ts"
import { scheduleDetachedCdpRelaunch } from "./cdp-relaunch.ts"
import type { CdpRelaunchOptions, CdpRelaunchResult } from "./cdp-relaunch.ts"
import { inspectTcpListener } from "./listener-safety.ts"
import type { ListenerAssessment } from "./listener-safety.ts"
import {
  APP_PATH,
  appProcessIds,
  appServerChildren,
  commandResult,
  resolveCodexAppCli,
  waitFor,
} from "./shared.ts"
import type { AppServerChild } from "./shared.ts"

export interface RuntimeInspection {
  ready: boolean
  pids: number[]
  listener: ListenerAssessment
  renderer: CdpTarget | null
  rendererError: string | null
  appServerChildren: AppServerChild[]
}

export interface RuntimeDependencies {
  appProcessIds: typeof appProcessIds
  resolveCodexAppCli: typeof resolveCodexAppCli
  commandResult: typeof commandResult
  discoverCodexRenderer: (cdpPort: number) => Promise<CdpTarget | null>
  inspectTcpListener: (port: number) => ListenerAssessment
  normalAppServerChildren: (args: {
    appPids: readonly number[]
    realCli: string
    appPath?: string
  }) => AppServerChild[]
  relaunchCdpApp: (options: CdpRelaunchOptions) => Promise<CdpRelaunchResult>
  waitFor: typeof waitFor
}

export interface EnsureRuntimeOptions {
  cdpPort?: number
  appPath?: string
  realCli?: string
  stateDir?: string
  timeoutMs?: number
  autoRestart?: boolean
  onStatus?: (status: string, details: Record<string, unknown>) => unknown
}

async function inspectRuntime(
  cdpPort: number,
  appPath: string,
  realCli: string,
  dependencies: RuntimeDependencies
): Promise<RuntimeInspection> {
  const pids = dependencies.appProcessIds(appPath)
  const listener = dependencies.inspectTcpListener(cdpPort)
  let renderer: CdpTarget | null = null
  let rendererError: string | null = null
  try {
    renderer = await dependencies.discoverCodexRenderer(cdpPort)
  } catch (error) {
    rendererError = error instanceof Error ? error.message : String(error)
  }
  const children =
    pids.length === 1
      ? dependencies.normalAppServerChildren({ appPids: pids, realCli, appPath })
      : []
  return {
    ready: pids.length === 1 && listener.loopbackOnly && Boolean(renderer) && children.length === 1,
    pids,
    listener,
    renderer,
    rendererError,
    appServerChildren: children,
  }
}

export async function ensureCodexCdpRuntime(
  options: EnsureRuntimeOptions = {},
  injected: Partial<RuntimeDependencies> = {}
) {
  const cdpPort = options.cdpPort ?? 9229
  const appPath = options.appPath ?? APP_PATH
  const stateDir = options.stateDir
  const timeoutMs = options.timeoutMs ?? 60_000
  const autoRestart = options.autoRestart !== false
  const onStatus = async (status: string, details: Record<string, unknown> = {}) =>
    options.onStatus?.(status, details)
  const dependencies: RuntimeDependencies = {
    appProcessIds,
    commandResult,
    resolveCodexAppCli,
    discoverCodexRenderer: (port) => discoverCodexRenderer(port),
    inspectTcpListener,
    normalAppServerChildren: appServerChildren,
    relaunchCdpApp: scheduleDetachedCdpRelaunch,
    waitFor,
    ...injected,
  }

  await onStatus("checking", { cdpPort })
  const realCli = dependencies.resolveCodexAppCli(appPath, options.realCli)
  const initial = await inspectRuntime(cdpPort, appPath, realCli, dependencies)
  if (initial.ready) {
    await onStatus("ready", { restarted: false, ...initial })
    return { ...initial, restarted: false }
  }
  if (initial.pids.length > 1) {
    throw new Error(`Expected at most one Codex App process, found ${initial.pids.length}`)
  }
  if (initial.pids.length === 1 && initial.appServerChildren.length !== 1) {
    throw new Error(
      `Codex App must own exactly one bundled App Server; found ${initial.appServerChildren.length}`
    )
  }
  if (initial.renderer && initial.pids.length !== 1) {
    throw new Error("Codex renderer is available but its App process could not be identified")
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
        const runtime = await inspectRuntime(cdpPort, appPath, realCli, dependencies)
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
