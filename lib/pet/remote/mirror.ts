// Whether this shell's pet tables are a companion MIRROR rather than the pet's
// own store (ADR-0219).
//
// The pet lives on the desktop. A phone, a browser companion and a desktop
// that is driving another Cognia host all read the pet tables as a read-only
// copy that companion sync overwrites on every pull. A local write there is
// worse than useless: it diverges from the host until the next pull reverts
// it, and on a desktop driving a remote host it would land in the wrong pet
// entirely. Every write-on-read convenience (the legacy binding migration in
// `usePet`, for one) asks this first.

import { detectPlatform, type Platform } from "@/lib/platform/detect"
import type { SyncableTable } from "@/lib/sync/types"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

/**
 * The pet tables companion sync mirrors (`lib/sync/handlers/pet.ts`). The
 * remote console pulls exactly these when it asks for a fresh copy, rather
 * than re-running every table the shell syncs.
 */
export const PET_MIRROR_TABLES = [
  "petProfile",
  "petAchievements",
  "petInventory",
  "petCharacterBindings",
  "petActivityLog",
] as const satisfies readonly SyncableTable[]

/** Whether a `sync://invalidate` for `table` touches the pet mirror. */
export function isPetMirrorTable(table: unknown): boolean {
  return (PET_MIRROR_TABLES as readonly unknown[]).includes(table)
}

export function isPetMirrorShell(
  deps: { platform?: Platform; remoteHostActive?: () => boolean } = {}
): boolean {
  const platform = deps.platform ?? detectPlatform()
  if (platform !== "tauri") return true
  return (deps.remoteHostActive ?? isRemoteHostActive)()
}
