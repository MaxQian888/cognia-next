// Backup-destination dispatcher. The local-disk path stays with its existing
// callers (executor / interval provider); this routes the remote destinations
// the `BackupDestination` enum reserves: WebDAV, GitHub and Google Drive.
// `convex` is deprecated (see `./config.ts`) and reports so explicitly.

import type { BackupDestination } from "@/types/scheduler"
import { isDeprecatedBackupDestination } from "./config"
import { uploadSnapshotToWebDav, type SnapshotMeta } from "./webdav"

export type DispatchResult = { ok: boolean; target?: string; error?: string }

/** The remote legs a destination value fans out to (`all` = every remote). */
export function remoteLegsFor(destination: BackupDestination | undefined): BackupDestination[] {
  if (destination === "all") return ["webdav", "github", "googledrive"]
  if (destination === "webdav" || destination === "github" || destination === "googledrive") {
    return [destination]
  }
  return []
}

/**
 * Send an already-encrypted envelope to ONE remote destination.
 *
 *   - `local` / `undefined`: no-op here — the caller handles disk writes.
 *   - `webdav`: upload to the WebDAV server.
 *   - `github`: commit into the configured private repository.
 *   - `googledrive`: upload into the configured Drive folder.
 *   - `all`: caller should fan out with {@link remoteLegsFor}; dispatching
 *     `all` directly targets WebDAV for backwards compatibility.
 *   - `convex` (deprecated) / anything else: unsupported.
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
  if (destination === "github") {
    const { uploadSnapshotToGithub } = await import("./github")
    const result = await uploadSnapshotToGithub(envelopeJson, meta)
    return result.ok ? { ok: true, target: result.remotePath } : { ok: false, error: result.error }
  }
  if (destination === "googledrive") {
    const { uploadSnapshotToGoogleDrive } = await import("./google-drive")
    const result = await uploadSnapshotToGoogleDrive(envelopeJson, meta)
    return result.ok ? { ok: true, target: result.remotePath } : { ok: false, error: result.error }
  }
  if (isDeprecatedBackupDestination(destination)) {
    return {
      ok: false,
      error: `Backup destination "${destination}" is deprecated and no longer supported.`,
    }
  }
  return {
    ok: false,
    error: `Backup destination "${destination}" is not supported in cognia-next.`,
  }
}
