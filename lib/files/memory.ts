// Tauri-side `memory_append` invocation used by the chat composer's `#…` mode.

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

export type MemoryScope = "project" | "user"

/**
 * Append a single memory line to either the project CLAUDE.md (when scope ==
 * "project") or the user-global ~/.claude/CLAUDE.md. Returns the absolute
 * path of the file that was written so the UI can show it to the user.
 */
export async function appendMemory(
  scope: MemoryScope,
  content: string,
  cwd: string | null | undefined,
  allowedRoots?: string[] | null
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Memory writes are only available in the desktop app.")
  }
  return invoke<string>("memory_append", {
    scope,
    content,
    cwd: cwd ?? null,
    // When the active workspace roots are supplied, the Rust host confines the
    // project CLAUDE.md write to them so a stray cwd cannot escape the workspace.
    allowedRoots: allowedRoots ?? null,
  })
}
