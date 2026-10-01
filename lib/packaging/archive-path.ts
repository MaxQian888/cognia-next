/**
 * Archive path normalization for signed packages.
 *
 * A leaf module on purpose: the template manifest validator imports it, and
 * that validator is reachable from plugin validation, so anything imported here
 * lands in the plugin store's import graph.
 */

/** Why a package file was refused, for callers that show it to a user. */
export const PACKAGE_FORMAT_ERROR_CODES = [
  "unsafe-path",
  "too-large",
  "too-many-files",
  "unsafe-expansion",
  "unreadable",
  "signature-invalid",
  "record-invalid",
  "duplicate-path",
  "file-missing",
  "checksum-mismatch",
  "undeclared-path",
  "manifest-missing",
  "manifest-not-json",
  "manifest-invalid",
] as const
export type PackageFormatErrorCode = (typeof PACKAGE_FORMAT_ERROR_CODES)[number]

/**
 * A package file that is malformed or unsafe. The message is the developer
 * detail, unchanged from the plain errors callers already match on; `code` is
 * what a UI translates.
 */
export class PackageFormatError extends Error {
  constructor(
    readonly code: PackageFormatErrorCode,
    message: string
  ) {
    super(message)
    this.name = "PackageFormatError"
  }
}

/** The code of a {@link PackageFormatError}, or `undefined` for any other error. */
export function packageFormatErrorCode(error: unknown): PackageFormatErrorCode | undefined {
  return error instanceof PackageFormatError ? error.code : undefined
}

/**
 * Normalize an archive path and refuse anything that could escape the package
 * root or name the same file two ways.
 */
export function safeArchivePath(input: string, maxDepth: number, label: string): string {
  const normalized = input.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new PackageFormatError("unsafe-path", `${label} path is unsafe: ${input}`)
  }
  if (normalized !== normalized.normalize("NFC")) {
    throw new PackageFormatError("unsafe-path", `${label} path is not canonical Unicode: ${input}`)
  }
  const parts: string[] = []
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue
    if (part === "..")
      throw new PackageFormatError("unsafe-path", `${label} path escapes its root: ${input}`)
    parts.push(part)
  }
  if (parts.length === 0 || parts.length > maxDepth) {
    throw new PackageFormatError("unsafe-path", `${label} path depth is unsafe: ${input}`)
  }
  return parts.join("/")
}
