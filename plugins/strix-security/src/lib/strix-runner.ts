// Scan orchestration state machine. Spawns a shell, prepares a fresh scan dir,
// runs `strix -n --target …` (streaming output to the console), then reads the
// report artifacts back over the PTY, normalizes them, and persists the run +
// findings to Dexie. Fully dependency-injected (terminal/dexie/clock/id/sleep)
// so it is unit-testable with a mock terminal + fake IndexedDB.

import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import type { PluginTerminalAPI } from "@/lib/plugin/api/terminal-api"
import type { ScanOptions, StrixRun } from "../types"
import { findingsTable, runsTable } from "../db"
import { buildStrixCommand, buildStrixEnv } from "./strix-cli"
import { parseRunJson, parseVulnerabilities } from "./parse-reports"
import { decodeBase64Utf8 } from "./pty-read"
import {
  captureCommand,
  openPty,
  quietShell,
  runCommand,
  safeKill,
  ScanAbortError,
  type PtyHandle,
  type PtyPollDeps,
} from "./pty"

export interface RunScanDeps {
  terminal: PluginTerminalAPI
  dexie: PluginDexieAPI
  now: () => number
  randomId: () => string
  sleep: (ms: number) => Promise<void>
  pollMs?: number
  signal?: AbortSignal
  onConsole?: (text: string) => void
  onRun?: (run: StrixRun) => void
}

// Per-scan working dir under the user's home so strix (and its Docker
// bind-mounts) get a real, inspectable path. Fresh per run ⇒ exactly one
// `strix_runs/*` output dir, making artifact discovery deterministic.
const SCAN_ROOT = "$HOME/.cognia/strix-scans"

export async function runScan(opts: ScanOptions, deps: RunScanDeps): Promise<StrixRun> {
  const runId = deps.randomId()
  const startedAt = deps.now()
  const runs = runsTable(deps.dexie)
  const findings = findingsTable(deps.dexie)
  const pollDeps: PtyPollDeps = { sleep: deps.sleep, pollMs: deps.pollMs, signal: deps.signal }

  let run: StrixRun = {
    runId,
    target: opts.target,
    model: opts.model?.trim() || undefined,
    startedAt,
    status: "running",
    findingsCount: 0,
    authorizedAt: startedAt,
  }
  await runs.put(run)
  deps.onRun?.(run)

  const update = async (patch: Partial<StrixRun>): Promise<void> => {
    run = { ...run, ...patch }
    await runs.put(run)
    deps.onRun?.(run)
  }

  const pty = await openPty(deps.terminal, {
    env: buildStrixEnv(opts),
    onConsole: deps.onConsole,
  })

  try {
    await quietShell(deps.terminal, pty)

    const scanDir = `${SCAN_ROOT}/${runId}`
    const setup = await runCommand(
      deps.terminal,
      pty,
      `mkdir -p "${scanDir}" && cd "${scanDir}"`,
      deps.randomId(),
      pollDeps
    )
    if (setup !== 0) {
      await update({
        status: "error",
        endedAt: deps.now(),
        exitCode: setup,
        error: `Could not prepare the scan directory (exit ${setup}).`,
      })
      return run
    }

    // Stream the scan output to the console during the run only.
    pty.forward(true)
    const exitCode = await runCommand(
      deps.terminal,
      pty,
      buildStrixCommand(opts),
      deps.randomId(),
      pollDeps
    )
    pty.forward(false)

    const vulns = await readJsonArtifact(deps, pty, "strix_runs/*/vulnerabilities.json")
    const meta = await readJsonArtifact(deps, pty, "strix_runs/*/run.json")

    const parsed = parseVulnerabilities(vulns, runId)
    if (parsed.length) await findings.bulkPut(parsed)

    const metaStatus = parseRunJson(meta).status
    const errored = exitCode === 1 || metaStatus === "error" || metaStatus === "failed"
    await update({
      status: errored ? "error" : "done",
      endedAt: deps.now(),
      exitCode,
      findingsCount: parsed.length,
      error: errored ? `Strix reported an error (exit ${exitCode}).` : undefined,
    })
    return run
  } catch (err) {
    if (err instanceof ScanAbortError) {
      await update({ status: "cancelled", endedAt: deps.now() })
      return run
    }
    await update({
      status: "error",
      endedAt: deps.now(),
      error: err instanceof Error ? err.message : String(err),
    })
    return run
  } finally {
    pty.dispose()
    await safeKill(deps.terminal, pty.id)
  }
}

async function readJsonArtifact(deps: RunScanDeps, pty: PtyHandle, glob: string): Promise<unknown> {
  const { raw, exitCode } = await captureCommand(
    deps.terminal,
    pty,
    `base64 ${glob} 2>/dev/null`,
    deps.randomId(),
    { sleep: deps.sleep, pollMs: deps.pollMs, signal: deps.signal }
  )
  if (exitCode !== 0) return null
  const text = decodeBase64Utf8(raw)
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
