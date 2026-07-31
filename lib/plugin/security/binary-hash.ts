/**
 * Content hashing for plugin-shipped executables.
 *
 * Shared by the two binary-spawn policies
 * (`lib/plugin/vscode-shim/lsp-binary-policy.ts`,
 * `lib/plugin/cli-tools/cli-binary-policy.ts`). Both compare the hash of the
 * bytes on disk *right now* against the hash the user approved in the
 * `approvedBinaries` ledger (v109) — that comparison is what makes an approval
 * scoped to specific bytes rather than to a name the plugin chose for itself.
 *
 * Reuses the existing primitives rather than adding a Tauri command:
 *   • `readBinaryFile` (`lib/file/file-operations.ts`) — `plugin-fs` under
 *     Tauri; the plugin install root is covered by the appdata-read-recursive
 *     capability.
 *   • `sha256Bytes` (`lib/ocr/hash.ts`) — Web Crypto `subtle.digest`, already
 *     polyfilled under Jest.
 */

/**
 * SHA-256 (lower-case hex) of the file at `path`, or `null` when it cannot be
 * read or hashed.
 *
 * **`null` means "unknown", never "fine".** Callers must treat it as a failure
 * to prove identity and prompt the user — a binary we cannot hash is exactly
 * the one we must not spawn silently.
 */
export async function hashBinaryFile(path: string): Promise<string | null> {
  try {
    const [{ readBinaryFile }, { sha256Bytes }] = await Promise.all([
      import("@/lib/file/file-operations"),
      import("@/lib/ocr/hash"),
    ])
    const bytes: unknown = await readBinaryFile(path)
    // A read that resolves with something other than bytes (an undefined
    // payload from a bridge that swallowed its own failure, a JSON-decoded
    // null) must NOT be hashed: `sha256Bytes` coerces such a value to an empty
    // buffer and returns the empty-string digest, which looks like a perfectly
    // valid identity and would let an unreadable binary satisfy an approval.
    const hashable = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes instanceof ArrayBuffer
        ? bytes
        : null
    if (!hashable) return null
    return await sha256Bytes(hashable)
  } catch {
    return null
  }
}
