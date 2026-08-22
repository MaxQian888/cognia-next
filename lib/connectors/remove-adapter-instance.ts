/**
 * Single removal path for a connector adapter instance.
 *
 * `deleteAdapterInstance` (lib/db/adapter-instances.ts) only drops the Dexie
 * row + heartbeats. Everything else an adapter leaves behind is cleaned here
 * so the two callers — the Settings row's Remove menu
 * (`components/settings/connections/adapters/adapter-list-row.tsx`) and the
 * plugin API (`lib/plugin/api/connectors-api.ts` `deleteInstance`) — cannot
 * drift:
 *
 *   1. Keyring purge (desktop only — the keyring is a Tauri command). Every
 *      account listed in `credentialsRef.accounts` is deleted best-effort; a
 *      credential that is already gone must never block the delete.
 *   2. Attachment cache prune (`pruneAttachmentsForAdapter`) — the encrypted
 *      blobs AND their Dexie rows. A row is only dropped once Rust confirms
 *      its file is gone; anything unconfirmed goes to `connectorCleanupJobs`
 *      so the ciphertext is retried rather than orphaned. Best-effort at this
 *      level for the same reason as step 1.
 *   3. Row delete — the only step that is allowed to throw.
 *
 * Order matters: secrets go first so a failure in step 3 leaves the row
 * (visible, retryable) rather than an orphaned credential.
 */

import { isTauri } from "@/lib/tauri"
import { connectorsKeyringDelete } from "@/lib/connectors/tauri/commands"
import { pruneAttachmentsForAdapter } from "@/lib/connectors/attachment-fetcher"
import { deleteAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

/** The subset of a row the removal path needs — full rows satisfy it too. */
export type RemovableAdapterInstance = Pick<AdapterInstanceRow, "id"> &
  Partial<Pick<AdapterInstanceRow, "credentialsRef">>

export interface RemoveAdapterInstanceResult {
  /** Keyring accounts that were deleted (empty off-desktop). */
  purgedCredentials: string[]
  /** Keyring accounts whose delete threw (already gone / keyring locked). */
  failedCredentials: string[]
  /** Attachments removed (blob + row); `null` when the prune itself failed. */
  prunedAttachments: number | null
}

export async function removeAdapterInstance(
  row: RemovableAdapterInstance
): Promise<RemoveAdapterInstanceResult> {
  const purgedCredentials: string[] = []
  const failedCredentials: string[] = []

  if (isTauri()) {
    for (const account of row.credentialsRef?.accounts ?? []) {
      try {
        await connectorsKeyringDelete(row.id, account)
        purgedCredentials.push(account)
      } catch {
        // Credential may already be gone, or the keyring may be locked —
        // never let a single secret block the removal.
        failedCredentials.push(account)
      }
    }
  }

  let prunedAttachments: number | null
  try {
    prunedAttachments = await pruneAttachmentsForAdapter(row.id)
  } catch {
    // Stale schema / transient Dexie error — the row delete still proceeds.
    prunedAttachments = null
  }

  await deleteAdapterInstance(row.id)

  return { purgedCredentials, failedCredentials, prunedAttachments }
}
