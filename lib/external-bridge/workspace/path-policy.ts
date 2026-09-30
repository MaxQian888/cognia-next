/**
 * Two-tier path policy for the External Bridge workspace tools (roadmap
 * 2026-09-29, Phase 1 "sensitive-path predicate").
 *
 * The host's `fs_*_workspace` commands confine a path to its root but do not
 * judge what the path IS: `SENSITIVE_FILE_NAMES` in `crates/cognia-files`
 * only hides credentials from `fs_walk_workspace`, while a read, a listing or
 * a content search still returns them. The in-app editor needs that (a user
 * opens their own `.env`); an external agent must not get it. So the bridge
 * classifies every path it touches into one of two tiers:
 *
 *  - **secret** — always denied, read or write, listed or searched: credential
 *    files and stores, and `.git` internals (object history keeps content that
 *    was deleted from the working tree). Built on the existing
 *    {@link isSensitiveResourcePath} (the `.env*` / key-extension / credential
 *    basename rule shared with the run-changes surface), extended with the
 *    names `crates/cognia-files` and the sidecar's `isSecretPath` hold that it
 *    lacks. Over-matching is the safe direction.
 *  - **bulk** — build output and dependency trees (`node_modules`, `target`,
 *    …, the same set as {@link SNAPSHOT_SKIP_DIRS}). Skipped in listings and
 *    searches so a scan does not drown in them, but a named file inside one is
 *    still readable: an agent debugging a dependency may open it on purpose.
 */

import { SNAPSHOT_SKIP_DIRS } from "@/lib/plugin/convert/source-snapshot"
import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"

export type PathTier = "secret" | "bulk" | "ordinary"

/**
 * Directory segments that mark a credential store. Mirrors the sidecar's
 * `SECRET_DIR_SEGMENTS` (`sidecar/src/policy/confinement/secret-paths.ts`),
 * plus `.git` — repository internals, never working-tree content.
 */
const SECRET_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
  ".docker",
  ".cognia",
])

/**
 * Credential basenames the shared predicate does not already cover: the rest
 * of `SENSITIVE_FILE_NAMES` (`crates/cognia-files/src/files.rs`) and the
 * sidecar's `SECRET_FILE_NAMES`.
 */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  ".envrc",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  ".git-credentials",
  "credentials",
  "credentials.toml",
  "id_dsa",
  "id_ecdsa",
])

/** Two-segment credential locations (`<dir>/<child>`). */
const SECRET_SEGMENT_PAIRS: readonly (readonly [string, string])[] = [
  [".config", "gh"],
  [".config", "gcloud"],
  [".config", "cognia"],
]

/** Split a root-relative path into lower-cased segments. */
function segmentsOf(relPath: string): string[] {
  return relPath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
}

export function classifyWorkspacePath(relPath: string): PathTier {
  const segments = segmentsOf(relPath)
  if (segments.length === 0) return "ordinary"
  const base = segments[segments.length - 1] ?? ""
  if (isSensitiveResourcePath(base) || SECRET_FILE_NAMES.has(base)) return "secret"
  // `id_rsa.pub`, `.npmrc.bak`: a listed name with an extension appended.
  const stem = base.includes(".", 1) ? base.slice(0, base.indexOf(".", 1)) : base
  if (stem !== base && (SECRET_FILE_NAMES.has(stem) || isSensitiveResourcePath(stem))) {
    return "secret"
  }
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? ""
    if (SECRET_DIR_SEGMENTS.has(segment)) return "secret"
    const next = segments[i + 1]
    if (next && SECRET_SEGMENT_PAIRS.some(([a, b]) => a === segment && b === next)) {
      return "secret"
    }
  }
  // Any directory segment (not the leaf itself) being a bulk tree.
  for (const segment of segments.slice(0, -1)) {
    if (SNAPSHOT_SKIP_DIRS.has(segment)) return "bulk"
  }
  return SNAPSHOT_SKIP_DIRS.has(base) ? "bulk" : "ordinary"
}

export function isSecretWorkspacePath(relPath: string): boolean {
  return classifyWorkspacePath(relPath) === "secret"
}

/**
 * Whether a shell command names a secret-tier path in any of its words.
 *
 * `classifyCommand` judges what a command DOES (`cat` is read-only, so it is
 * allowed); it has no notion of which file is a credential. This closes the
 * obvious gap — `cat .env` through `shell_run` — by escalating such a command
 * to an in-app approval. It is a tripwire, not a sandbox: a command can always
 * reach a file indirectly, which is why `shell:run` is its own default-OFF
 * scope and says so in Settings.
 */
export function commandTouchesSecretPath(command: string): boolean {
  const words = command.split(/[\s"'`;|&<>()=]+/).filter(Boolean)
  return words.some((word) => !word.startsWith("-") && isSecretWorkspacePath(word))
}
