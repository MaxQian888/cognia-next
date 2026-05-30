// Backup-destination dispatcher. The local-disk path stays with its existing
// callers (executor / interval provider); this routes the remote destinations
// the `BackupDestination` enum reserves. Only `webdav` is wired so far.

import type { BackupDestination } from "@/types/scheduler"
import { uploadSnapshotToWebDav, type SnapshotMeta } from "./webdav"

export type DispatchResult = { ok: boolean; target?: string; error?: string }

/**
 * Send an already-encrypted envelope to a remote destination.
 *
 *   - `local` / `undefined`: no-op here — the caller handles disk writes.
 *   - `webdav` / `all`: upload to the WebDAV server.
 *   - anything else (`github` / `googledrive` / `convex`): unsupported.
 */
export async function dispatchBackupDestination(
  destination: BackupDestination | undefined,
  envelopeJson: string,
  meta: SnapshotMeta
): Promise<DispatchResult> {
  if (destination === undefined || destination === "local") {
    return { ok: true, target: "local" }
  }
  if (destination === "webdav" || destination === "all") {
    const result = await uploadSnapshotToWebDav(envelopeJson, meta)
    return result.ok ? { ok: true, target: result.remotePath } : { ok: false, error: result.error }
  }
  return {
    ok: false,
    error: `Backup destination "${destination}" is not supported in cognia-next.`,
  }
}
