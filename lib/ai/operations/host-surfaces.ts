/**
 * Which operation surfaces this process can execute on. A descriptor's
 * `surfaces` says where an operation's I/O can physically run. This is the
 * other half: where we are.
 *
 * - A browser window is the `renderer`. Inside the Tauri shell it can also
 *   reach the local Rust proxy (`rust-proxy`).
 * - Anything without a window (the CLI, the sidecar, tests) is `sidecar`.
 */

import type { ProviderOperationSurface } from "@cognia/provider-types"

import { isTauri } from "@/lib/tauri"

export function detectHostSurfaces(): ProviderOperationSurface[] {
  if (typeof window === "undefined") return ["sidecar"]
  return isTauri() ? ["renderer", "rust-proxy"] : ["renderer"]
}
