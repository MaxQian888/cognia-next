// Bridge between the Rust-side `a2ui_bridge_runtime_paths` Tauri command and
// the projection-time resolver in `./resolve.ts`. The Rust command exposes
// the absolute paths the resolver needs (`sidecarDir`, `socketPath`); this
// module wraps the IPC + caches the result for the process lifetime.
//
// Outside Tauri (web preview, Jest jsdom) the wrapper returns `null`. In that
// mode `lib/claude/sync.ts` already short-circuits with `not-tauri`, so any
// hypothetical caller that still asks for the context simply skips
// resolution — leaving placeholders in place is harmless because the
// projection itself doesn't run.

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import type { BuiltinMcpResolveContext } from "./resolve"

interface RuntimePathsRaw {
  sidecar_dir: string
  socket_path: string
}

let cached: Promise<BuiltinMcpResolveContext | null> | null = null

async function fetchRuntimePaths(): Promise<BuiltinMcpResolveContext | null> {
  if (!isTauri()) return null
  const raw = await invoke<RuntimePathsRaw>("a2ui_bridge_runtime_paths")
  return {
    sidecarDir: raw.sidecar_dir,
    socketPath: raw.socket_path,
  }
}

/**
 * Resolve the absolute paths the builtin-MCP resolver needs. Cached for the
 * process lifetime — the underlying paths only change on app restart.
 *
 * Returns `null` outside Tauri.
 */
export async function getBuiltinMcpRuntimeContext(): Promise<BuiltinMcpResolveContext | null> {
  if (!cached) {
    cached = fetchRuntimePaths().catch((err) => {
      // Reset the cache so a transient failure (e.g. Tauri not yet booted) is
      // retried on the next call rather than poisoning the entire session.
      cached = null
      throw err
    })
  }
  return cached
}

/** Test-only: clear the in-memory cache. */
export function __resetForTests(): void {
  cached = null
}
