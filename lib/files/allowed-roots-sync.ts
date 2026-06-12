// Bridges the renderer's workspace roots into the Rust FS allowed-roots
// registry (ADR-0028 follow-up).
//
// The raw `read_text_file` / `write_text_file` / `ensure_dir` commands are
// shadow-gated in Rust against a process-global set of allowed roots
// (`src-tauri/src/files.rs`). Rust seeds the structural dirs (appdata, home
// config trees, documents) at startup; this module adds the user's workspace
// roots and dialog-chosen directories so the shadow-mode containment check has
// the full picture. No-op on web/mobile.

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { allRootPaths } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"
import { createLogger } from "@/lib/logging"

const log = createLogger("files.allowed-roots-sync")

/** Push every known workspace root into the Rust FS allowed-roots registry. */
export async function syncAllowedRootsToRust(): Promise<void> {
  if (!isTauri()) return
  try {
    const projects = useProjectStore.getState().projects
    const paths = Array.from(new Set(projects.flatMap((p) => allRootPaths(p))))
    if (paths.length === 0) return
    await invoke("fs_set_allowed_roots", { paths })
  } catch (e) {
    // A failed sync only means the shadow check logs a few extra out-of-root
    // accesses until the next successful sync — never break the app.
    log.warn("sync_failed", { error: String(e) })
  }
}

/**
 * Register a dialog-chosen path (a file's parent dir, or a chosen folder) so a
 * subsequent raw/confined write to it sits inside an allowed root. Call right
 * after a successful `save()` / `open()` dialog gesture.
 */
export async function registerDialogPathInRust(path: string): Promise<void> {
  if (!isTauri() || !path) return
  try {
    await invoke("fs_allow_dialog_path", { path })
  } catch (e) {
    log.warn("dialog_register_failed", { error: String(e) })
  }
}
