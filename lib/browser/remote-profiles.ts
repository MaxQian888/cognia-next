/**
 * Delete a cloud-browser profile (ADR-0085) everywhere it lives.
 *
 * A persistent profile is two things: a row here that names it, and a
 * user-data directory on the workspace runtime holding the sign-ins and site
 * storage the cloud browser kept for it. Deleting only the row — the one thing
 * `deleteBrowserProfile` does — left all of that on the server with nothing
 * pointing at it any more. The runtime is erased first, so a failure there
 * leaves the profile listed and retryable rather than orphaned.
 */

import { deleteBrowserProfile } from "@/lib/db/browser-profiles"
import { transport } from "@/lib/tauri/transport-instance"

/** Why a profile could not be deleted, for the settings card to explain. */
export type RemoteProfileDeleteFailure = "in-use" | "unreachable" | "failed"

export class RemoteProfileDeleteError extends Error {
  constructor(
    readonly reason: RemoteProfileDeleteFailure,
    cause: unknown
  ) {
    super(`browser profile delete failed: ${reason}`, { cause })
    this.name = "RemoteProfileDeleteError"
  }
}

/** Classify a gateway refusal by the code it carries. */
export function remoteProfileDeleteFailure(error: unknown): RemoteProfileDeleteFailure {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (text.includes("browser_profile_in_use")) return "in-use"
  if (
    text.includes("browser_disabled") ||
    text.includes("browser_runtime_unavailable") ||
    text.includes("remote browser support is not compiled")
  ) {
    return "unreachable"
  }
  return "failed"
}

export async function deleteRemoteBrowserProfile(
  workspaceId: string,
  profileId: string
): Promise<void> {
  try {
    await transport.call("browser_profile_delete", { workspaceId, profileId })
  } catch (error) {
    throw new RemoteProfileDeleteError(remoteProfileDeleteFailure(error), error)
  }
  await deleteBrowserProfile(profileId)
}
