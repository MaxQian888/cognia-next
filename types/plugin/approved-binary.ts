/**
 * Dexie row shape for the user-consent binary ledger (`approvedBinaries`, v109).
 *
 * This table is the **only** thing that can grant a plugin-shipped executable a
 * prompt-free spawn. It replaces the `trustedPublishers` fingerprint model,
 * which was security theater: an extension asserted its own publisher
 * fingerprint in its manifest, the policy matched that string against a table
 * seeded with placeholders **checked into the repo source**, and a hit granted
 * `child_process.spawn` with no prompt. There was no proof of possession
 * anywhere in the chain.
 *
 * The replacement model carries no claim about *who* published the binary —
 * only that **this user**, on **this machine**, approved **these exact bytes**
 * at **this exact path**. That is a statement we can actually verify:
 *   • `pluginId` + `binaryPath` — scope, so approving one plugin's binary never
 *     leaks trust to another's.
 *   • `sha256` — identity of the bytes. Re-hashed on every evaluation; any
 *     drift (update, tamper, swap) misses the ledger and re-prompts.
 *
 * The row is deliberately NOT a "trust the publisher forever" record. There is
 * no wildcard, no publisher scope, and no inheritance. See
 * `lib/plugin/vscode-shim/lsp-binary-policy.ts` and
 * `lib/plugin/cli-tools/cli-binary-policy.ts` for the readers, and
 * `lib/db/approved-binaries.ts` for the CRUD surface.
 *
 * Lives under `types/plugin/` next to `vscode-extension-cache.ts` per
 * `lib/db/CONVENTIONS.md`; `lib/db/schema.ts` re-exports it so
 * `@/lib/db/schema` stays a stable import surface.
 */

/**
 * One user approval of one binary, at one path, with one exact content hash.
 * Primary key is the compound `[pluginId+binaryPath]`.
 */
export interface ApprovedBinaryRow {
  /** Plugin that owns the binary. Approvals never cross plugin boundaries. */
  pluginId: string
  /**
   * Absolute path of the approved executable, as passed to the policy.
   * Stored verbatim (not normalised) so the ledger reflects exactly what the
   * user saw in the consent prompt; the policy normalises on lookup.
   */
  binaryPath: string
  /**
   * Lower-case hex SHA-256 of the binary's bytes at approval time. The policy
   * re-hashes the file on every evaluation and compares; a mismatch means the
   * bytes changed since consent and the user is prompted again.
   */
  sha256: string
  /** Epoch milliseconds when the user granted the approval. */
  approvedAt: number
}
