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
 *   3. Residue reap (`reapAdapterResidue`) — every OTHER table this adapter
 *      wrote to: audit, dedup ledger, queued outbound, inbox telemetry, the
 *      Lark session tables, per-conversation overrides, and the identities only
 *      this bot ever saw. All of it is unreachable once the row is gone, and
 *      none of it has a sweep of its own. See that module for the two
 *      categories deliberately kept.
 *   4. Row delete — the only step that is allowed to throw.
 *
 * Order matters: secrets go first so a failure in step 4 leaves the row
 * (visible, retryable) rather than an orphaned credential. The reap runs BEFORE
 * the row delete for the same reason — a half-reaped adapter whose row survives
 * can be removed again; one whose row is already gone cannot be found.
 */

import { hasCapability, serverBackedCapabilities } from "@/lib/platform/capabilities"
import { connectorsKeyringDelete } from "@/lib/connectors/tauri/commands"
import { ensureCredentialLease } from "@/lib/connectors/credential-lease"
import { pruneAttachmentsForAdapter } from "@/lib/connectors/attachment-fetcher"
import { reapAdapterResidue, type AdapterResidueReport } from "@/lib/connectors/adapter-residue"
import { deleteAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

/**
 * The subset of a row the removal path needs — full rows satisfy it too.
 * `type` is optional because a plugin may remove an id whose row is already
 * gone; without it the conversation-scoped residue cannot be located, and the
 * reap reports those tables as unreachable instead of claiming they were clean.
 */
export type RemovableAdapterInstance = Pick<AdapterInstanceRow, "id"> &
  Partial<Pick<AdapterInstanceRow, "type" | "credentialsRef">>

export interface RemoveAdapterInstanceResult {
  /** Keyring accounts that were deleted. */
  purgedCredentials: string[]
  /**
   * Keyring accounts whose delete threw — already gone, keyring locked, or
   * a host that refused the write. Reporting them beats the old behaviour,
   * which skipped the purge entirely off-desktop and left orphaned secrets
   * behind under a `purgedCredentials: []` that read as "nothing to do".
   */
  failedCredentials: string[]
  /** Attachments removed (blob + row); `null` when the prune itself failed. */
  prunedAttachments: number | null
  /** Per-table counts of the derived rows reaped, and any table that refused. */
  residue: AdapterResidueReport
}

export async function removeAdapterInstance(
  row: RemovableAdapterInstance
): Promise<RemoveAdapterInstanceResult> {
  const purgedCredentials: string[] = []
  const failedCredentials: string[] = []

  // Gate on the capability, not on Tauri: a companion paired to a cloud brain
  // has a connector runtime, and skipping the purge there strands the very
  // credentials the removal is meant to destroy.
  const connectorRuntime =
    hasCapability("connector-runtime") || serverBackedCapabilities().includes("connector-runtime")

  if (connectorRuntime) {
    // The purge is the one write in this function that leaves something behind
    // when it is refused, so it gets the lease the device plane asks for
    // (ADR-0152). A no-op wherever the keyring is local.
    await ensureCredentialLease()
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

  const residue = await reapAdapterResidue(row)

  await deleteAdapterInstance(row.id)

  return { purgedCredentials, failedCredentials, prunedAttachments, residue }
}
