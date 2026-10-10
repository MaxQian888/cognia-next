/**
 * Host-injectable reader for a project-local `.cognia/lsp.json`.
 *
 * Injected into `resolveLspServers` (`lib/lsp/resolve-config.ts`) as the
 * `readProjectFile` dependency. Kept out of the pure resolver so that module
 * stays filesystem-free and unit-testable. Returns `null` whenever the file
 * is absent, unreadable, or malformed, or when not running under Tauri (web /
 * mobile shells have no project filesystem) — the project layer is then empty.
 *
 * Reads through the root-confined `fs_read_workspace_file`, not the raw
 * absolute-path read: the root can be a character's or a session's working
 * directory that was never registered as a project root, and the raw read
 * refuses anything outside the registered roots.
 */

import { isTauri } from "@/lib/tauri"
import { readWorkspaceFile } from "@/lib/files/workspace-fs"
import type { LspProjectFile } from "@/types/lsp/config"

/** Relative path of the project-local config under a workspace root. */
export const PROJECT_LSP_CONFIG_RELPATH = ".cognia/lsp.json"

/**
 * Read `<rootDir>/.cognia/lsp.json`. Returns the parsed file, or `null` on any
 * failure (missing file, parse error, or non-Tauri host without an injected reader).
 */
export async function readProjectLspFile(
  rootDir: string,
  read?: (rootDir: string, relPath: string) => Promise<string>
): Promise<LspProjectFile | null> {
  if (!read && !isTauri()) return null
  let raw: string
  try {
    raw = await (read ?? readWorkspaceFile)(rootDir, PROJECT_LSP_CONFIG_RELPATH)
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
