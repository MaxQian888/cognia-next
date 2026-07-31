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

    const parsed = vulns.kind === "parsed" ? parseVulnerabilities(vulns.value, runId) : []
    if (parsed.length) await findings.bulkPut(parsed)

    const metaStatus = parseRunJson(meta.kind === "parsed" ? meta.value : null).status
    // An unreadable report must never render as a clean bill of health.
    const unreadable = vulns.kind === "unreadable"
    const errored =
      exitCode === 1 || metaStatus === "error" || metaStatus === "failed" || unreadable
    await update({
      status: errored ? "error" : "done",
      endedAt: deps.now(),
      exitCode,
      findingsCount: parsed.length,
      error: unreadable
        ? `Strix produced a vulnerability report that could not be parsed (${vulns.detail}). ` +
          `Treat this run as INCONCLUSIVE, not as zero findings.`
        : errored
          ? `Strix reported an error (exit ${exitCode}).`
          : undefined,
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

/**
 * Outcome of reading one JSON artifact.
 *
 * `absent` and `unreadable` used to collapse into a single `null`, which then
 * became `findingsCount: 0, status: "done"`. For a security scanner those two
 * cases could not be more different:
 *
 *  - `absent`     — strix writes no report when it has nothing to report, so a
 *                   missing file IS the clean-scan signal (see the
 *                   "clean scan / no report file" test).
 *  - `unreadable` — the file was produced and read back, but we could not
 *                   parse it. Reporting that as "0 findings" tells the user
 *                   a scan that may have found criticals came back clean.
 */
type ArtifactRead =
  { kind: "absent" } | { kind: "parsed"; value: unknown } | { kind: "unreadable"; detail: string }

async function readJsonArtifact(
  deps: RunScanDeps,
  pty: PtyHandle,
  glob: string
): Promise<ArtifactRead> {
  const { raw, exitCode } = await captureCommand(
    deps.terminal,
    pty,
    `base64 ${glob} 2>/dev/null`,
    deps.randomId(),
    { sleep: deps.sleep, pollMs: deps.pollMs, signal: deps.signal }
  )
  // Non-zero exit = the glob matched nothing, i.e. no report was produced.
  if (exitCode !== 0) return { kind: "absent" }
  const text = decodeBase64Utf8(raw)
  if (!text.trim()) return { kind: "absent" }
  try {
    return { kind: "parsed", value: JSON.parse(text) }
  } catch (err) {
    return {
      kind: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Deps for artifact purging — a strict subset of {@link RunScanDeps}. */
export interface PurgeDeps {
  terminal: PluginTerminalAPI
  randomId: () => string
  sleep: (ms: number) => Promise<void>
  pollMs?: number
  signal?: AbortSignal
}

/**
 * `runId`s are UUIDs from `deps.randomId()`. Anything else must never reach an
 * `rm -rf`, so the purge refuses to interpolate a value that isn't one — a
 * corrupted or hand-edited Dexie row cannot widen the delete.
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Remove a run's on-disk artifacts.
 *
 * Deleting a run used to clear only the Dexie rows, leaving
 * `$HOME/.cognia/strix-scans/<runId>/` — which holds `vulnerabilities.json`
 * with full PoC exploits and code snippets — on disk forever, with no GC path
 * at all. A user clearing pentest results against a client system reasonably
 * believes the exploits are gone.
 *
 * Best-effort: a failure here must not block the Dexie delete, so callers get
 * a boolean instead of a throw.
 */
export async function purgeRunArtifacts(runId: string, deps: PurgeDeps): Promise<boolean> {
  if (!RUN_ID_RE.test(runId)) return false
  return purgePaths([`${SCAN_ROOT}/${runId}`], deps)
}

/** Remove every scan's artifacts (the "Clear all" path). */
export async function purgeAllArtifacts(deps: PurgeDeps): Promise<boolean> {
  return purgePaths([SCAN_ROOT], deps)
}

async function purgePaths(paths: string[], deps: PurgeDeps): Promise<boolean> {
  let pty: PtyHandle | null = null
  try {
    pty = await openPty(deps.terminal, {})
    await quietShell(deps.terminal, pty)
    const pollDeps: PtyPollDeps = {
      sleep: deps.sleep,
      pollMs: deps.pollMs,
      signal: deps.signal,
    }
    for (const path of paths) {
      const code = await runCommand(
        deps.terminal,
        pty,
        `rm -rf "${path}"`,
        deps.randomId(),
        pollDeps
      )
      if (code !== 0) return false
    }
    return true
  } catch {
    return false
  } finally {
    if (pty) {
      pty.dispose()
      await safeKill(deps.terminal, pty.id)
    }
  }
}
