/**
 * Tauri-backed reader for a project-local `.cognia/lsp.json`.
 *
 * Injected into `resolveLspServers` (`lib/lsp/resolve-config.ts`) as the
 * `readProjectFile` dependency. Kept out of the pure resolver so that module
 * stays filesystem-free and unit-testable. Returns `null` whenever the file
 * is absent, unreadable, or malformed, or when not running under Tauri (web /
 * mobile shells have no project filesystem) — the project layer is then empty.
 */

import { isTauri } from "@/lib/tauri"
import { readTextFile } from "@/lib/claude/ipc"
import type { LspProjectFile } from "@/types/lsp/config"

/** Relative path of the project-local config under a workspace root. */
export const PROJECT_LSP_CONFIG_RELPATH = ".cognia/lsp.json"

function joinRoot(rootDir: string, rel: string): string {
  const sep = rootDir.includes("\\") && !rootDir.includes("/") ? "\\" : "/"
  const trimmed = rootDir.endsWith("/") || rootDir.endsWith("\\") ? rootDir.slice(0, -1) : rootDir
  return `${trimmed}${sep}${rel.split("/").join(sep)}`
}

/**
 * Read `<rootDir>/.cognia/lsp.json`. Returns the parsed file, or `null` on any
 * failure (missing file, parse error, non-Tauri host).
 */
export async function readProjectLspFile(rootDir: string): Promise<LspProjectFile | null> {
  if (!isTauri()) return null
  let raw: string
  try {
    raw = await readTextFile(joinRoot(rootDir, PROJECT_LSP_CONFIG_RELPATH))
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LspProjectFile
    }
    return null
  } catch {
    return null
  }
}
