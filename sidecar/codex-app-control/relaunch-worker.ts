/** Detached worker that preserves App ownership and only enables loopback CDP. */

import { buildCdpOnlyAppOpenArgs } from "./launch-config.ts"
import { discoverCodexRenderer } from "./cdp-bootstrap.ts"
import { inspectTcpListener } from "./listener-safety.ts"
import {
  APP_BUNDLE_ID,
  appProcessIds,
  appServerChildren,
  commandResult,
  parseCommonOptions,
  relayPaths,
  sleep,
  waitFor,
  writeJsonAtomic,
} from "./shared.ts"

export interface RelaunchWorkerArgs {
  stateDir: string
  realCli: string
  appPath: string
  cdpPort: number
  delaySeconds: number
  attemptId: string | null
}

/** The worker's flags (cdp-relaunch.ts writes them): the common set plus delay and attempt id. */
export function parseRelaunchWorkerArgs(argv: readonly string[]): RelaunchWorkerArgs {
  const options = parseCommonOptions(argv)
  if (options.cdpPort == null) throw new Error("--cdp-port is required")
  const delayIndex = argv.indexOf("--delay-seconds")
  const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 15
  const attemptIndex = argv.indexOf("--attempt-id")
  const attemptId = attemptIndex >= 0 ? (argv[attemptIndex + 1] ?? null) : null
  return {
    stateDir: options.stateDir,
    realCli: options.realCli,
    appPath: options.appPath,
    cdpPort: options.cdpPort,
    delaySeconds,
    attemptId,
  }
}

/**
 * Quit the App, relaunch it with loopback-only CDP, and prove the relaunch is
 * safe (one App process, a renderer target, a loopback listener, one
 * App-owned App Server) — or roll back to a normal launch. Every step is
 * recorded to the result file `scheduleDetachedCdpRelaunch` polls.
 * Returns the process exit code.
 */
export async function runCdpOnlyRelaunchWorker(argv: readonly string[]): Promise<number> {
  const options = parseRelaunchWorkerArgs(argv)
  const paths = relayPaths(options.stateDir)
  let appWasStopped = false

  const record = async (status: string, details: Record<string, unknown> = {}): Promise<void> => {
    await writeJsonAtomic(paths.cdpOnlyRelaunchResult, {
      status,
      at: new Date().toISOString(),
      attemptId: options.attemptId,
      cdpAddress: `127.0.0.1:${options.cdpPort}`,
      ...details,
    })
  }

  const requestQuit = async (): Promise<void> => {
    if (appProcessIds().length === 0) return
    const quit = commandResult("/usr/bin/osascript", [
      "-e",
      `tell application id "${APP_BUNDLE_ID}" to quit`,
    ])
    await record("waiting-for-app-exit", {
      quitRequest: quit.ok ? "accepted" : "manual-quit-required",
      quitError: quit.ok ? null : quit.stderr || quit.error,
      currentAppPids: appProcessIds(),
    })
    await waitFor(() => appProcessIds().length === 0, {
      timeoutMs: 180_000,
      intervalMs: 250,
      description: "Codex App graceful or manual exit",
    })
  }

  const openCdpOnlyApp = (): void => {
    const opened = commandResult(
      "/usr/bin/open",
      buildCdpOnlyAppOpenArgs({ appPath: options.appPath, cdpPort: options.cdpPort })
    )
    if (!opened.ok)
      throw new Error(opened.stderr || opened.error || "Unable to launch CDP-only App")
  }

  const openNormalApp = (): void => {
    const opened = commandResult("/usr/bin/open", ["--new", options.appPath])
    if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to restore normal App")
  }

  const restoreNormalApp = async (cdpError: string): Promise<void> => {
    await record("cdp-health-failed", { error: cdpError })
    try {
      await requestQuit()
      openNormalApp()
      await waitFor(() => appProcessIds().length === 1, {
        timeoutMs: 30_000,
        intervalMs: 250,
        description: "normal Codex App rollback launch",
      })
      await record("auto-rolled-back", { cdpError, appPids: appProcessIds() })
    } catch (rollbackError) {
      await record("rollback-blocked", {
        cdpError,
        rollbackError:
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      })
    }
  }

  await record("countdown", { delaySeconds: options.delaySeconds, currentAppPids: appProcessIds() })
  await sleep(options.delaySeconds * 1000)

  try {
    await record("quitting-current-app", { currentAppPids: appProcessIds() })
    await requestQuit()
    appWasStopped = true
    await record("launching-cdp-only-app")
    openCdpOnlyApp()
    await waitFor(() => appProcessIds().length === 1, {
      timeoutMs: 30_000,
      intervalMs: 250,
      description: "CDP-only Codex App launch",
    })
    const renderer = await waitFor(() => discoverCodexRenderer(options.cdpPort).catch(() => null), {
      timeoutMs: 30_000,
      intervalMs: 250,
      description: "Codex renderer CDP target",
    })
    const listener = await waitFor(
      () => {
        const inspected = inspectTcpListener(options.cdpPort)
        return inspected.loopbackOnly ? inspected : null
      },
      { timeoutMs: 15_000, intervalMs: 250, description: "loopback-only CDP listener" }
    )
    const children = await waitFor(
      () => {
        const found = appServerChildren({ appPids: appProcessIds(), realCli: options.realCli })
        return found.length === 1 ? found : null
      },
      { timeoutMs: 30_000, intervalMs: 250, description: "normal App-owned App Server child" }
    )
    await record("ready", {
      appPids: appProcessIds(),
      renderer: { id: renderer.id, url: renderer.url ?? null },
      listener,
      appServerChildren: children,
      cliOverride: false,
      sharedDaemon: false,
    })
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!appWasStopped) {
      await record("restart-cancelled-app-still-normal", {
        error: message,
        currentAppPids: appProcessIds(),
      })
    } else {
      await restoreNormalApp(message)
    }
    return 1
  }
}
