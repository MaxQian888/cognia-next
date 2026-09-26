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
} from "./shared.ts"
import type { ControlPaths } from "./shared.ts"

const TERMINAL_STATUSES: ReadonlySet<unknown> = new Set([
  "ready",
  "auto-rolled-back",
  "rollback-blocked",
  "restart-cancelled-app-still-normal",
])

/** The result file the detached worker keeps up to date (relaunch-worker.ts). */
export interface CdpRelaunchRecord {
  status: string
  attemptId?: string
  error?: string
  cdpError?: string
  [key: string]: unknown
}

export interface CdpRelaunchOptions {
  stateDir?: string | undefined
  appPath?: string
  realCli?: string
  cdpPort?: number
  delaySeconds?: number
  timeoutMs?: number
}

export type CdpRelaunchResult = CdpRelaunchRecord & { reused: boolean }

export function buildDetachedCdpRelaunch({
  attemptId,
  stateDir,
  appPath = APP_PATH,
  realCli = DEFAULT_REAL_CLI,
  cdpPort = 9229,
  delaySeconds = 0,
  label = `${CDP_ONLY_RELAUNCH_LABEL_PREFIX}.${process.getuid?.() ?? 0}`,
}: CdpRelaunchOptions & { attemptId: string; label?: string }): {
  attemptId: string
  label: string
  paths: ControlPaths
  launchArgs: string[]
} {
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

export interface RelaunchDependencies {
  commandResult: typeof commandResult
  ensurePrivateDirectory: typeof ensurePrivateDirectory
  launchctlJobExists: typeof launchctlJobExists
  readJson: (path: string) => Promise<unknown>
  waitFor: typeof waitFor
  writeJsonAtomic: typeof writeJsonAtomic
}

const asRecord = (value: unknown): CdpRelaunchRecord | null =>
  typeof value === "object" && value !== null ? (value as CdpRelaunchRecord) : null

export async function scheduleDetachedCdpRelaunch(
  options: CdpRelaunchOptions = {},
  injected: Partial<RelaunchDependencies> = {}
): Promise<CdpRelaunchResult> {
  const dependencies: RelaunchDependencies = {
    commandResult,
    ensurePrivateDirectory,
    launchctlJobExists,
    readJson,
    waitFor,
    writeJsonAtomic,
    ...injected,
  }
  const label = `${CDP_ONLY_RELAUNCH_LABEL_PREFIX}.${process.getuid?.() ?? 0}`
  const existing = dependencies.launchctlJobExists(label)
  let attemptId: string
  if (existing) {
    const active = asRecord(
      await dependencies.readJson(relayPaths(options.stateDir).cdpOnlyRelaunchResult)
    )
    if (!active?.attemptId)
      throw new Error(`A CDP relaunch is active without an attempt id: ${label}`)
    attemptId = active.attemptId
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
      const current = asRecord(await dependencies.readJson(submission.paths.cdpOnlyRelaunchResult))
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
