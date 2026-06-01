// Bridges the Dexie workspace-trust ledger into the Rust hooks trust gate.
//
// Project/local-scope settings.json hooks load only for trusted workspace roots,
// and that gate is enforced in Rust (`src-tauri/src/hooks/trust.rs`) so a
// compromised renderer can't bypass it. The trust ledger itself lives in Dexie
// (`lib/db/trusted-workspaces.ts`); this module pushes the current set into Rust
// at startup and after every trust change. No-op on web/mobile.

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { listTrustedWorkspaces } from "@/lib/db/trusted-workspaces"
import { createLogger } from "@/lib/logging"

const log = createLogger("claude.hook-trust-sync")

/** Push the full Dexie trust ledger into the Rust hooks trust gate. */
export async function syncTrustedWorkspacesToRust(): Promise<void> {
  if (!isTauri()) return
  try {
    const rows = await listTrustedWorkspaces()
    await invoke("set_trusted_workspaces", { paths: rows.map((r) => r.path) })
  } catch (e) {
    // A failed sync must never break the app; it only means project-scope hooks
    // stay disabled until the next successful sync.
    log.warn("sync_failed", { error: String(e) })
  }
}
