/**
 * CRUD for `approvedBinaries` (v109) — the user-consent ledger for
 * plugin-shipped executables.
 *
 * This table is the sole grant surface for a prompt-free binary spawn. It
 * replaced `trustedPublishers`, whose fingerprint model let a plugin assert its
 * own publisher identity as a bare string and get `child_process.spawn` for
 * free (see `types/plugin/approved-binary.ts` for the full post-mortem).
 *
 * The ledger makes exactly one claim, and it is one we can verify locally:
 * *this user approved these exact bytes at this exact path for this plugin*.
 * There is no publisher scope, no wildcard, and no inheritance — approving one
 * binary grants nothing to any other.
 *
 * Readers: `lib/plugin/vscode-shim/lsp-binary-policy.ts` and
 * `lib/plugin/cli-tools/cli-binary-policy.ts`. Both re-hash the file on every
 * evaluation and compare against `sha256`, so an approval survives only as long
 * as the bytes do.
 */

import { getDb } from "./schema"
import type { ApprovedBinaryRow } from "@/types/plugin/approved-binary"

export type { ApprovedBinaryRow }

/**
 * Look up the approval for one `(pluginId, binaryPath)` pair.
 *
 * Returns `undefined` on miss — callers treat that as "not approved", never as
 * an error. Note this does NOT compare hashes: the caller re-hashes the binary
 * and compares against `row.sha256` itself, so the mismatch case stays
 * explicit at the policy layer rather than hiding inside a lookup.
 */
export async function findApprovedBinary(
  pluginId: string,
  binaryPath: string
): Promise<ApprovedBinaryRow | undefined> {
  return getDb().approvedBinaries.get([pluginId, binaryPath])
}

/**
 * Record (or refresh) a user approval. Overwrites any prior approval for the
 * same `(pluginId, binaryPath)` — re-approving an updated binary replaces the
 * stale hash rather than accumulating rows.
 *
 * `approvedAt` defaults to now; tests pin it.
 */
export async function recordBinaryApproval(input: {
  pluginId: string
  binaryPath: string
  sha256: string
  approvedAt?: number
}): Promise<ApprovedBinaryRow> {
  const row: ApprovedBinaryRow = {
    pluginId: input.pluginId,
    binaryPath: input.binaryPath,
    sha256: input.sha256,
    approvedAt: input.approvedAt ?? Date.now(),
  }
  await getDb().approvedBinaries.put(row)
  return row
}

/** Revoke one approval. No-op when the row is already absent. */
export async function revokeBinaryApproval(pluginId: string, binaryPath: string): Promise<void> {
  await getDb().approvedBinaries.delete([pluginId, binaryPath])
}

/**
 * List approvals, newest first. Pass `pluginId` to scope to one plugin;
 * omit it to list the whole ledger (Settings → the "what have I approved?"
 * surface).
 */
export async function listApprovedBinaries(pluginId?: string): Promise<ApprovedBinaryRow[]> {
  const table = getDb().approvedBinaries
  const rows =
    pluginId === undefined
      ? await table.toArray()
      : await table.where("pluginId").equals(pluginId).toArray()
  return rows.sort((a, b) => b.approvedAt - a.approvedAt)
}

/**
 * Drop every approval belonging to a plugin. Called on uninstall — a
 * reinstalled plugin must earn consent again, since the bytes behind the same
 * path may have changed entirely.
 */
export async function clearApprovedBinariesForPlugin(pluginId: string): Promise<number> {
  return getDb().approvedBinaries.where("pluginId").equals(pluginId).delete()
}
