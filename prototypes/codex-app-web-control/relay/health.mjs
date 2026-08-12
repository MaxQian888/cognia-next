#!/usr/bin/env node

/** Read-only relay and process-tree verification. */

import {
  appProcessIds,
  commandResult,
  fetchRelay,
  parseCommonOptions,
  readSecret,
  relayPaths,
} from "./shared.mjs"
import { discoverCodexRenderer } from "./cdp-bootstrap.mjs"
import { inspectTcpListener } from "./listener-safety.mjs"

const options = parseCommonOptions(process.argv.slice(2))
const paths = relayPaths(options.stateDir)
const token = await readSecret(paths.token)
const state = await fetchRelay("/api/state", { port: options.port, token })
const cdpTarget =
  options.cdpPort == null ? null : await discoverCodexRenderer(options.cdpPort).catch(() => null)
const cdpListener = options.cdpPort == null ? null : inspectTcpListener(options.cdpPort)

function parentPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const result = commandResult("/bin/ps", ["-o", "ppid=", "-p", String(pid)])
  return result.ok ? Number(result.stdout.trim()) : null
}

const appPids = appProcessIds()
const checks = {
  initialized: state.initialized === true,
  exactlyOneDesktopApp: appPids.length === 1,
  shimBelongsToApp: parentPid(state.shimPid) === state.appPid && appPids.includes(state.appPid),
  appServerBelongsToShim: parentPid(state.appServerPid) === state.shimPid,
  activeTaskVisible: typeof state.activeThreadId === "string" && state.activeThreadId.length > 0,
  loopbackPort: state.port === options.port,
  ...(options.cdpPort == null
    ? {}
    : {
        cdpConfigured: state.cdp?.enabled === true && state.cdp?.port === options.cdpPort,
        cdpRendererVisible: cdpTarget != null,
        cdpLoopbackOnly: cdpListener?.loopbackOnly === true,
      }),
}
const result = {
  healthy: Object.values(checks).every(Boolean),
  checks,
  processTree: {
    desktopAppPids: appPids,
    appPid: state.appPid,
    shimPid: state.shimPid,
    appServerPid: state.appServerPid,
  },
  activeThreadId: state.activeThreadId,
  cdp:
    options.cdpPort == null
      ? null
      : {
          port: options.cdpPort,
          rendererId: cdpTarget?.id ?? null,
          rendererUrl: cdpTarget?.url ?? null,
          listener: cdpListener,
        },
  operatorUrl: `http://127.0.0.1:${options.port}/#token=${encodeURIComponent(token)}`,
  statePath: paths.state,
  logPath: paths.log,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (!result.healthy) process.exitCode = 1
