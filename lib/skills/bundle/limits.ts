// Centralised caps for the skill-bundle pipeline. Kept in one module so
// the loader (TS), the persistence layer (Dexie), and the disk mirror
// (Rust ↔ TS bridge) agree on the same numbers. Changing a constant here
// flows through tests via direct imports.
//
// Per-file vs. per-target differences:
//
//   - `MAX_ZIP_TOTAL_BYTES` mirrors the VSIX installer's 200 MB cap.
//   - `MAX_RESOURCE_BYTES_WEB` is the upper bound when a web/mobile shell
//     has to inline a resource into the Dexie `SkillResource[]` row
//     (text → utf-8, binary → base64). 16 MB keeps the IndexedDB
//     transaction comfortable without hard-coding a tiny limit that
//     blocks legitimate community bundles.
//   - `MAX_RESOURCE_BYTES_DISK` mirrors the Rust `MAX_RESOURCE_BYTES`
//     constant in `src-tauri/src/skills/native.rs` (2 MB). When a bundle
//     authored on the web ever syncs to a Tauri device, the mirror push
//     surfaces a per-resource `tooLargeForDisk` warning instead of
//     silently truncating.
//   - `MAX_RESOURCES_PER_SKILL` mirrors the Rust cap of 50 entries.

export const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024
export const MAX_RESOURCE_BYTES_WEB = 16 * 1024 * 1024
export const MAX_RESOURCE_BYTES_DISK = 2 * 1024 * 1024
export const MAX_RESOURCES_PER_SKILL = 50

/**
 * Single-source-of-truth resource path validator. Mirrors the Rust
 * `validate_resource_path` rules (no empty segments, no `..`, no leading
 * absolute separator, no `.` segments). Returns `null` on success or a
 * human-readable reason string. Pure — safe to call from any shell.
 */
export function validateResourcePath(rel: string): string | null {
  if (!rel || rel.length === 0) return "empty path"
  if (rel.includes("..")) return `path traversal in: ${rel}`
  if (rel.startsWith("/") || rel.startsWith("\\")) return `absolute path: ${rel}`
  for (const segment of rel.split(/[\\/]/)) {
    if (segment === "" || segment === ".") return `invalid segment in: ${rel}`
  }
  return null
}

/**
 * Mirror of the Rust `validate_dir_name` rules: ASCII alphanumerics plus
 * `-` and `_`, length 1..64, no leading/trailing `-`. Returned separately
 * from the path validator so callers can surface dir-name conflicts with
 * a different message than path-traversal warnings.
 */
export function validateDirName(name: string): string | null {
  if (!name) return "dir name is empty"
  if (name.length > 64) return "dir name too long (max 64)"
  if (name.startsWith("-") || name.endsWith("-")) return "dir name cannot start or end with '-'"
  for (const ch of name) {
    const ok = /[A-Za-z0-9_-]/.test(ch)
    if (!ok) return `invalid character in dir name: ${ch}`
  }
  return null
}
