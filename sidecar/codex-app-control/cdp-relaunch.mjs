import { randomBytes } from "node:crypto"

import {
  APP_PATH,
  CDP_ONLY_RELAUNCH_LABEL_PREFIX,
  DEFAULT_REAL_CLI,
  commandResult,
  ensurePrivateDirectory,
  launchctlJobExists,
  readJson,
  relayPaths,
  waitFor,
  workerPath,
  writeJsonAtomic,
} from "./shared.mjs"

const TERMINAL_STATUSES = new Set([
  "ready",
  "auto-rolled-back",
  "rollback-blocked",
  "restart-cancelled-app-still-normal",
])

export function buildDetachedCdpRelaunch({
  attemptId,
  stateDir,
  appPath = APP_PATH,
  realCli = DEFAULT_REAL_CLI,
  cdpPort = 9229,
  delaySeconds = 0,
  label = `${CDP_ONLY_RELAUNCH_LABEL_PREFIX}.${process.getuid()}`,
}) {
  const paths = relayPaths(stateDir)
  const workerArgs = [
    workerPath("cdp-only-relaunch-worker.mjs"),
    "--state-dir",
    paths.root,
    "--real-cli",
    realCli,
    "--app-path",
    appPath,
    "--cdp-port",
    String(cdpPort),
    "--delay-seconds",
    String(delaySeconds),
    "--attempt-id",
    attemptId,
  ]
  const launchArgs = [
    "submit",
    "-l",
    label,
    "-o",
    paths.cdpOnlyRelaunchStdout,
    "-e",
    paths.cdpOnlyRelaunchStderr,
    "--",
    process.execPath,
    workerPath("one-shot-launcher.mjs"),
    "--label",
    label,
    "--",
    process.execPath,
    ...workerArgs,
  ]
  return { attemptId, label, paths, launchArgs }
}

export async function scheduleDetachedCdpRelaunch(options = {}, injected = {}) {
  const dependencies = {
    commandResult,
    ensurePrivateDirectory,
    launchctlJobExists,
    readJson,
    waitFor,
    writeJsonAtomic,
    ...injected,
  }
  const label = `${CDP_ONLY_RELAUNCH_LABEL_PREFIX}.${process.getuid()}`
  const existing = dependencies.launchctlJobExists(label)
  let attemptId
  if (existing) {
    const active = await dependencies.readJson(relayPaths(options.stateDir).cdpOnlyRelaunchResult)
    attemptId = active?.attemptId
    if (!attemptId) throw new Error(`A CDP relaunch is active without an attempt id: ${label}`)
  } else {
    attemptId = randomBytes(12).toString("hex")
  }
  const submission = buildDetachedCdpRelaunch({ ...options, attemptId, label })

  if (!existing) {
    await dependencies.ensurePrivateDirectory(submission.paths.root)
    await dependencies.writeJsonAtomic(submission.paths.cdpOnlyRelaunchResult, {
      status: "armed",
      at: new Date().toISOString(),
      attemptId,
      delaySeconds: options.delaySeconds ?? 0,
      cdpAddress: `127.0.0.1:${options.cdpPort ?? 9229}`,
      label,
    })
    const submitted = dependencies.commandResult("/bin/launchctl", submission.launchArgs)
    if (!submitted.ok) {
      throw new Error(submitted.stderr || submitted.error || "Unable to submit CDP relaunch job")
    }
  }

  const result = await dependencies.waitFor(
    async () => {
      const current = await dependencies.readJson(submission.paths.cdpOnlyRelaunchResult)
      return current?.attemptId === attemptId && TERMINAL_STATUSES.has(current.status)
        ? current
        : null
    },
    {
      timeoutMs: options.timeoutMs ?? 240_000,
      intervalMs: 250,
      description: "detached Codex App CDP relaunch",
    }
  )
  if (result.status !== "ready") {
    throw new Error(
      result.error ??
        result.cdpError ??
        `Detached Codex App CDP relaunch finished with status ${result.status}`
    )
  }
  return { ...result, reused: existing }
}
