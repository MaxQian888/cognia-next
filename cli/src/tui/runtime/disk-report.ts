/**
 * `/doctor` disk report: how much room this machine has, and where the CLI's
 * own footprint sits. It prints the commands the user could run to reclaim
 * space and performs zero changes itself. The filesystem it receives is a
 * read-only facade, so there is no path by which it could delete anything.
 */

import fs from "node:fs"
import path from "node:path"

import {
  directoryBytes,
  formatBytes,
  freeBytesAt,
  type ReadOnlyDirFs,
  type StatfsFn,
} from "../../util/disk"

export interface DiskReportEntry {
  label: string
  path: string
  /** Undefined when the directory does not exist or cannot be read. */
  bytes?: number
  /** What the user could run to reclaim it. Never run by the report. */
  reclaim?: string
}

export interface DiskReport {
  checkedAt: number
  /** Free bytes on the filesystem holding the config home. */
  freeBytes?: number
  entries: DiskReportEntry[]
}

export interface DiskReportDeps {
  /** Config home (`~/.cognia`). */
  home: string
  /** Repository root when the CLI runs inside a checkout, for `cli/dist` and `target/`. */
  repoRoot?: string
  fsx?: ReadOnlyDirFs
  statfs?: StatfsFn
  now?: () => number
}

function quoted(p: string): string {
  return `"${p}"`
}

/** The directories the report measures, with the reclaim command for each. */
export function diskReportTargets(home: string, repoRoot?: string): DiskReportEntry[] {
  const sessions = path.join(home, "sessions")
  const logs = path.join(home, "logs")
  const checkpoints = path.join(home, "checkpoints")
  const targets: DiskReportEntry[] = [
    {
      label: "Sessions",
      path: sessions,
      reclaim: "cognia-agent sdk sessions   # review, then: cognia-agent sdk delete <id>",
    },
    { label: "Logs", path: logs, reclaim: `rm -rf ${quoted(logs)}` },
    { label: "Checkpoints", path: checkpoints, reclaim: `rm -rf ${quoted(checkpoints)}` },
  ]
  if (repoRoot) {
    const dist = path.join(repoRoot, "cli", "dist")
    const target = path.join(repoRoot, "target")
    targets.push(
      {
        label: "CLI build",
        path: dist,
        reclaim: `rm -rf ${quoted(dist)}   # pnpm cli:build rebuilds it`,
      },
      { label: "Cargo target", path: target, reclaim: `cargo clean   # in ${quoted(repoRoot)}` }
    )
  }
  return targets
}

export async function buildDiskReport(deps: DiskReportDeps): Promise<DiskReport> {
  const fsx = deps.fsx ?? fs.promises
  const checkedAt = (deps.now ?? Date.now)()
  const freeBytes = await freeBytesAt(deps.home, deps.statfs)
  const entries: DiskReportEntry[] = []
  for (const target of diskReportTargets(deps.home, deps.repoRoot)) {
    const bytes = await directoryBytes(target.path, fsx)
    entries.push(bytes === undefined ? { ...target, reclaim: undefined } : { ...target, bytes })
  }
  return {
    checkedAt,
    ...(freeBytes !== undefined ? { freeBytes } : {}),
    entries,
  }
}

/** Plain-text rendering, one line per entry, then the commands. */
export function formatDiskReport(report: DiskReport): string {
  const lines = [`Free space:   ${formatBytes(report.freeBytes)}`]
  for (const entry of report.entries) {
    const size = entry.bytes === undefined ? "absent" : formatBytes(entry.bytes)
    lines.push(`  ${entry.label.padEnd(13)} ${size.padStart(9)}  ${entry.path}`)
  }
  const reclaimable = report.entries.filter((entry) => entry.reclaim && (entry.bytes ?? 0) > 0)
  if (reclaimable.length > 0) {
    lines.push("To reclaim (nothing is deleted by this report):")
    for (const entry of reclaimable) lines.push(`  ${entry.reclaim}`)
  }
  return lines.join("\n")
}
