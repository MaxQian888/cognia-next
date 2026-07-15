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
    const bytes = await readBinaryFile(path)
    return await sha256Bytes(bytes)
  } catch {
    return null
  }
}
