/**
 * Confined write/mkdir backend for the secure file-IO façade.
 *
 * Thin wrapper over the authoritative Rust `*_confined` commands (see
 * `lib/claude/ipc.ts` and `src-tauri/src/files.rs`). Kept as its own module so
 * `secure-fs.ts` stays runtime-agnostic and so tests can inject a fake backend
 * without a Tauri host. Web mode (no Rust) rejects — there is no safe confined
 * write target in the browser, and the secure layer's only production consumers
 * run inside the desktop shell.
 */

import { isTauri } from "@/lib/tauri"
import { ensureDirConfined, writeTextFileConfined } from "@/lib/claude/ipc"

/** The on-disk-confined mutations the secure façade delegates to. */
export interface ConfinedOps {
  writeText(path: string, content: string, allowedRoots: string[]): Promise<void>
  mkdir(path: string, allowedRoots: string[]): Promise<void>
}

/** Default backend — calls the Rust host; throws in web mode. */
export const confinedOps: ConfinedOps = {
  async writeText(path, content, allowedRoots) {
    if (!isTauri()) {
      throw new Error("Confined file writes are only available in the desktop app.")
    }
    await writeTextFileConfined(path, content, allowedRoots)
  },
  async mkdir(path, allowedRoots) {
    if (!isTauri()) {
      throw new Error("Confined directory creation is only available in the desktop app.")
    }
    await ensureDirConfined(path, allowedRoots)
  },
}
