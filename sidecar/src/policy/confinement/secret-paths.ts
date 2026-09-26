// Protected credential paths: the hard-deny set for every built-in tool, read
// or write, whether or not a confinement policy is configured.

import path from "node:path"

// --- Protected credential paths (mirror of Rust `sandbox/protected.rs`
// `is_secret_protected`). Neither readable nor writable inside the sandbox; here
// they are the hard-deny set for every tool. `.env` is deliberately NOT listed —
// it is a normal project file the agent legitimately reads/writes.

/**
 * Directory segments that mark a credential store.
 *
 * Kept in union with `cli/src/agent/tool-host/policy.ts`. The two enforcement
 * points stay separate on purpose (Cognia must not trust a check running inside
 * the process it confines), but the DATA must not drift — and it had: `.cognia`
 * existed only CLI-side, while `.gpg` / `.config/gcloud` existed only here.
 */
const SECRET_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
  ".docker",
  ".npmrc",
  ".cognia",
  ".config/gcloud",
  ".config/cognia",
])

/** Basenames that are themselves credential files anywhere on disk. */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  ".git-credentials",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
])

/**
 * Two-segment secret paths (`<dir>/<child>`), e.g. `~/.config/gh`. The last
 * two segments of Rust's multi-segment rels ride this list too
 * (`.local/share/cognia` → `share/cognia`, `AppData/Roaming/cognia` →
 * `roaming/cognia`, `Library/Application Support/cognia` →
 * `application support/cognia`) — over-deny on an unrelated `share/cognia`
 * is the safe direction.
 */
const SECRET_SEGMENT_PAIRS: readonly (readonly [string, string])[] = [
  [".config", "gh"],
  [".cargo", "credentials.toml"],
  ["share", "cognia"],
  ["local", "cognia"],
  ["roaming", "cognia"],
  ["application support", "cognia"],
]

/**
 * Case-fold on the platforms with case-insensitive filesystems. macOS was
 * missing, so a first write to `~/.AWS/credentials` on a machine with no
 * existing `~/.aws` slipped past (an existing path is normally saved by
 * `realpathSync.native` returning the true on-disk case).
 */
function foldCase(s: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s
}

/** Split an absolute path into normalized, case-folded segments. */
function segmentsOf(abs: string): string[] {
  return foldCase(path.normalize(abs))
    .split(/[\\/]+/)
    .filter(Boolean)
}

/**
 * True when `abs` is, sits under, or names a protected credential path.
 * Segment-based so it is drive/UNC/`~`-agnostic and case-correct per platform.
 */
export function isSecretPath(abs: unknown): boolean {
  if (typeof abs !== "string" || abs.length === 0) return false
  const segs = segmentsOf(abs)
  const base = segs[segs.length - 1]
  if (base && SECRET_FILE_NAMES.has(base)) return true
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] ?? ""
    if (SECRET_DIR_SEGMENTS.has(seg)) return true
    // Multi-segment dir markers ("config/gcloud").
    if (i + 1 < segs.length && SECRET_DIR_SEGMENTS.has(`${seg}/${segs[i + 1]}`)) return true
    for (const [a, b] of SECRET_SEGMENT_PAIRS) {
      if (seg === a && segs[i + 1] === b) return true
    }
  }
  return false
}
