/**
 * Guarded read/write for external agent-memory files. Honors the "不能随意修改"
 * requirement: reads are always safe; saves refuse paths outside the allowed
 * roots and always back the original up to `<path>.bak` (via `copyFile`) before
 * overwriting. Desktop-only — web mode cannot touch the user's filesystem.
 *
 * Dependency-injected so the guard logic is unit-testable without a real disk.
 */

import { isDescendant } from "@/lib/claude/instructions/paths"
import { isTauri } from "@/lib/tauri"

export interface EditDeps {
  readText?: (path: string) => Promise<string>
  writeText?: (path: string, contents: string) => Promise<void>
  copy?: (from: string, to: string) => Promise<void>
  exists?: (path: string) => Promise<boolean>
  /** Override desktop detection (tests). */
  isDesktop?: boolean
}

async function realDeps(deps: EditDeps): Promise<Required<Omit<EditDeps, "isDesktop">>> {
  const ops = await import("@/lib/file/file-operations")
  return {
    readText: deps.readText ?? ops.readTextFile,
    writeText: deps.writeText ?? ops.writeTextFile,
    copy: deps.copy ?? ops.copyFile,
    exists: deps.exists ?? ops.exists,
  }
}

/** Suffix appended to the backup copy written before an overwrite. */
export const BACKUP_SUFFIX = ".bak"

/** Read a file's text. Safe to call for read-only files. */
export async function loadExternalFile(absPath: string, deps: EditDeps = {}): Promise<string> {
  const { readText } = await realDeps(deps)
  return readText(absPath)
}

export interface SaveOptions extends EditDeps {
  /** Absolute roots the write must stay within (e.g. ~/.claude, ~/.codex, workspace). */
  allowedRoots: string[]
}

export interface SaveResult {
  /** The backup path written, or null when there was no pre-existing file to back up. */
  backupPath: string | null
}

/**
 * Save `content` to `absPath` after confirming it sits under an allowed root and
 * backing up any existing content to `<path>.bak`. Throws (without writing) on a
 * non-desktop runtime or an out-of-bounds path.
 */
export async function saveExternalFile(
  absPath: string,
  content: string,
  options: SaveOptions
): Promise<SaveResult> {
  const isDesktop = options.isDesktop ?? isTauri()
  if (!isDesktop) {
    throw new Error("External memory writes are only available in the desktop app.")
  }
  if (!isWithinAllowedRoots(absPath, options.allowedRoots)) {
    throw new Error(`Refusing to write outside the allowed roots: ${absPath}`)
  }
  const { readText, writeText, copy, exists } = await realDeps(options)

  let backupPath: string | null = null
  if (await exists(absPath)) {
    // Read first so a copy failure surfaces before we touch the original.
    await readText(absPath)
    backupPath = absPath + BACKUP_SUFFIX
    await copy(absPath, backupPath)
  }
  await writeText(absPath, content)
  return { backupPath }
}

/** True when `absPath` is at/under any allowed root (case-normalized). */
export function isWithinAllowedRoots(absPath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => root && isDescendant(root, absPath))
}
