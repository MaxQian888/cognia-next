/**
 * Read-only disk facts: free bytes on a filesystem and the size of a
 * directory tree. Extracted from the eval preflight's statfs read so the
 * `/doctor` disk report and the preflight share one implementation.
 *
 * Nothing here writes, unlinks or renames. The facades are deliberately
 * read-only interfaces so a caller cannot reach a mutating method through
 * them.
 */

import fs from "node:fs"

export interface StatfsLike {
  bavail: number | bigint
  bsize: number | bigint
}

export type StatfsFn = (path: string) => Promise<StatfsLike>

export interface ReadOnlyDirFs {
  readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>
  stat(path: string): Promise<{ size: number }>
}

/** Free bytes available to this user on the filesystem holding `dir`, or undefined. */
export async function freeBytesAt(
  dir: string,
  statfs: StatfsFn = fs.promises.statfs
): Promise<number | undefined> {
  try {
    const filesystem = await statfs(dir)
    const bytes = Number(filesystem.bavail) * Number(filesystem.bsize)
    return Number.isFinite(bytes) ? bytes : undefined
  } catch {
    return undefined
  }
}

/**
 * Total file bytes under `dir`, walking directories and skipping anything
 * that is neither a file nor a directory. Undefined when `dir` cannot be
 * read at all (missing is the common case).
 */
export async function directoryBytes(
  dir: string,
  fsx: ReadOnlyDirFs = fs.promises
): Promise<number | undefined> {
  let entries: Awaited<ReturnType<ReadOnlyDirFs["readdir"]>>
  try {
    entries = await fsx.readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  let total = 0
  for (const entry of entries) {
    const child = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      total += (await directoryBytes(child, fsx)) ?? 0
    } else if (entry.isFile()) {
      try {
        total += (await fsx.stat(child)).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

const UNITS = ["B", "KB", "MB", "GB", "TB"]

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "?"
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`
}
