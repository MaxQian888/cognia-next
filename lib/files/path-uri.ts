// Shared conversion between absolute filesystem paths and `file://` URIs.
//
// Extracted from `lib/plugin/vscode-shim/lsp-workspace-manager.ts` so both the
// LSP workspace materialiser and the Monaco workbench (`file` surface) address
// on-disk documents with byte-identical URIs — a mismatch would break
// `resolveWorkspaceFolder` prefix matching and cross-file LSP navigation.
//
// Rules (must stay in lockstep with the Rust side that emits `file://` URIs):
//   - Backslashes (Windows) are normalised to forward slashes.
//   - A drive-letter path (`C:\x`) becomes `file:///C:/x`.
//   - A POSIX absolute path (`/home/x`) becomes `file:///home/x`.
//   - Path segments are percent-encoded per-segment (spaces, `#`, `?`, …) so
//     the URI round-trips; separators and the drive colon are preserved.

/** Convert an absolute filesystem path to a `file://` URI. Synchronous — no IO. */
export function pathToFileUri(absolutePath: string): string {
  const normalised = absolutePath.replace(/\\/g, "/")
  const hasDrive = /^[a-zA-Z]:/.test(normalised)
  // Encode each segment individually so `/` and the drive `:` survive.
  const encoded = normalised
    .split("/")
    .map((segment, index) => {
      // Preserve a leading drive letter segment (e.g. `C:`) unencoded.
      if (index === 0 && /^[a-zA-Z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
  if (hasDrive) {
    return `file:///${encoded}`
  }
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`
}

/**
 * Convert a `file://` URI back to an absolute filesystem path. Inverse of
 * `pathToFileUri`. Returns `null` when the input is not a `file://` URI.
 */
export function fileUriToPath(fileUri: string): string | null {
  if (!fileUri.startsWith("file://")) return null
  // Strip scheme + authority. `file:///x` and `file://host/x` both leave the
  // absolute path after the third slash for the local (empty-authority) form
  // we emit; we only ever produce empty-authority URIs.
  let rest = fileUri.slice("file://".length)
  // Drop an (always-empty) authority component.
  if (rest.startsWith("/")) {
    // Windows drive form `file:///C:/x` → rest = `/C:/x`; strip the leading
    // slash so decode yields `C:/x`. POSIX `file:///home/x` → `/home/x` kept.
    const afterSlash = rest.slice(1)
    if (/^[a-zA-Z]:/.test(afterSlash)) {
      rest = afterSlash
    }
  }
  const decoded = rest
    .split("/")
    .map((segment) => {
      if (/^[a-zA-Z]:$/.test(segment)) return segment
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join("/")
  return decoded
}
