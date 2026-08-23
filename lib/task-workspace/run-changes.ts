/**
 * Display projection of a task-workspace patch set.
 *
 * The patch set is the ONLY run-scoped change record a non-owning device can
 * read: `resource.changed` journal events are written `visibility: "private"`
 * because they name workspace paths, so they never sync to a phone, while
 * `task_workspace_get_patch_set` is a read-only companion RPC any paired
 * device with `workspace.read` may call.
 *
 * What this module exists to prevent is a diff pane that renders empty and is
 * read as "nothing changed". Two independent reasons a body can come back
 * empty, neither of which is an error:
 *
 *  - `build_patch_set` (crates/cognia-task-workspace/src/ledger.rs) stores
 *    hunks ONLY for a `modified`, non-binary, regular file. A created,
 *    deleted, renamed, binary or symlink change is recorded with `hunks: []`.
 *  - `read_patch_diff` concatenates exactly those stored hunks, so for such a
 *    file it returns `""` — a success, not a failure.
 *
 * So availability is decided here from METADATA, before any request is made,
 * and every non-`available` reason is a label the surface renders in place of
 * a diff. Nothing asks the host for a body it already knows is not there.
 */

import type { ChangeKind, PatchSet } from "./types"

/** Why a file's diff body is, or is not, showable. */
export type ChangeDiffAvailability =
  | "available"
  /** Recorded as binary — the ledger stores no textual hunks. */
  | "binary"
  /** A symlink change: the target moved, there is no line diff. */
  | "symlink"
  /** Created / deleted / renamed — real, but the ledger keeps no hunks for it. */
  | "noTextDiff"
  /** A credential-shaped path. Never requested from this surface. */
  | "sensitive"

/** Every value {@link ChangeDiffAvailability} can take, for label coverage. */
export const CHANGE_DIFF_AVAILABILITIES: readonly ChangeDiffAvailability[] = Object.freeze([
  "available",
  "binary",
  "symlink",
  "noTextDiff",
  "sensitive",
])

/** Every value {@link ChangeKind} can take, for label coverage. */
export const RUN_CHANGE_KINDS: readonly ChangeKind[] = Object.freeze([
  "created",
  "modified",
  "deleted",
  "renamed",
])

const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
])

const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set(["pem", "key", "p12", "pfx"])

/**
 * Whether a workspace-relative path is credential-shaped.
 *
 * Mirrors `is_sensitive_resource` in
 * `crates/cognia-task-workspace/src/resource.rs`. The host stays the
 * authority — `read_patch_diff` refuses a sensitive path outright unless the
 * caller proved `workspace.write`, and this surface never asks for that. The
 * mirror exists so a `.env` renders as "withheld" instead of as a failed
 * request that looks like a bug.
 *
 * Drift is safe in BOTH directions, which is why duplicating the rule is
 * acceptable here: a path this misses is still refused by the host, and a path
 * this over-matches is merely hidden from a phone screen. Neither direction
 * can leak a credential.
 */
export function isSensitiveResourcePath(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").toLowerCase()
  const name = normalized.split("/").pop() ?? normalized
  if (name === ".env" || name.startsWith(".env.")) return true
  if (SENSITIVE_NAMES.has(name)) return true
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return false
  return SENSITIVE_EXTENSIONS.has(name.slice(dot + 1))
}

export interface RunChangeFile {
  path: string
  oldPath?: string
  kind: ChangeKind
  /**
   * Line counts, present ONLY when the ledger stored hunks for this file.
   *
   * Optional rather than zero-defaulted on purpose: a created file has no
   * hunks, and reporting it as "+0 −0" would state that an added file added
   * nothing.
   */
  stats?: { additions: number; deletions: number }
  hunkCount: number
  availability: ChangeDiffAvailability
}

export interface RunChangeSet {
  /**
   * The run this set describes.
   *
   * Load-bearing, not provenance: the patch is fetched asynchronously after a
   * turn is selected, so the surface keys per-file expansion off this. Without
   * it, switching turns leaves rows expanded that belong to the previous one.
   */
  runId: string
  files: RunChangeFile[]
  totals: {
    files: number
    additions: number
    deletions: number
    /** Files whose body this surface will not render, for any reason. */
    withheld: number
  }
}

function availabilityOf(file: PatchSet["files"][number]): ChangeDiffAvailability {
  // Sensitivity outranks every other reason: the answer must not depend on
  // whether the ledger happened to keep hunks for a credential file.
  if (isSensitiveResourcePath(file.path)) return "sensitive"
  if (file.resourceKind === "symlink") return "symlink"
  if (file.binary) return "binary"
  return file.hunks.length > 0 ? "available" : "noTextDiff"
}

export function projectPatchSetChanges(patch: PatchSet): RunChangeSet {
  let additions = 0
  let deletions = 0
  let withheld = 0

  const files = patch.files.map((file) => {
    const availability = availabilityOf(file)
    if (availability !== "available") withheld += 1
    const entry: RunChangeFile = {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      kind: file.kind,
      hunkCount: file.hunks.length,
      availability,
    }
    if (file.hunks.length === 0) return entry
    const stats = file.hunks.reduce(
      (acc, hunk) => ({
        additions: acc.additions + (hunk.additions ?? 0),
        deletions: acc.deletions + (hunk.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 }
    )
    // A withheld file's lines are not counted into the run total — the totals
    // line describes what is actually on screen.
    if (availability === "available") {
      additions += stats.additions
      deletions += stats.deletions
    }
    return { ...entry, stats }
  })

  files.sort((left, right) => left.path.localeCompare(right.path))

  return {
    runId: patch.runId,
    files,
    totals: { files: files.length, additions, deletions, withheld },
  }
}
