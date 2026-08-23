/**
 * The cockpit's per-run detail projection.
 *
 * `latestSnapshot` already carries the timeline and the artifacts — the reducer
 * builds both on every append — so this module does NOT re-reduce them. What it
 * adds is the two views the snapshot deliberately leaves out:
 *
 *  - **Changes.** `resource.changed` is written with `visibility: "private"`
 *    because it names workspace paths, and the snapshot is projected onto IM
 *    cards. It is read here from the raw journal, which only the machine that
 *    owns the workspace can do.
 *  - **Tests.** Verification artifacts are ordinary artifacts in the snapshot;
 *    the cockpit shows them in their own section, so they are split out.
 *
 * Pure — no Dexie, no React. The hook supplies the snapshot and the events.
 */

import type {
  RunActivitySnapshot,
  RunArtifactSnapshot,
  RunEvent,
  RunProjectionSnapshot,
  RunVerificationSummary,
} from "@/types/execution/run"

/**
 * One changed workspace resource.
 *
 * Paths only — never content, never a diff. The cockpit's job is to say WHAT
 * moved; opening it is the source-control surface's job.
 */
export interface RunChangeEntry {
  path: string
  oldPath?: string
  /** `created` / `modified` / `deleted` / `renamed`, as the producer recorded it. */
  changeKind?: string
  origin?: string
  /**
   * The producer marked this resource's CONTENT sensitive (a dotfile of
   * secrets, say). Surfaced as a flag rather than used to hide the row: the
   * person at this machine owns the file and needs to know it was touched.
   */
  sensitive: boolean
}

/**
 * Completeness of the change list.
 *
 * `overflowCount` and `completeness` are carried through verbatim because a
 * truncated list that presents itself as whole is the failure mode worth
 * guarding: "3 files changed" and "3 files changed, more not captured" are
 * different answers.
 */
export interface RunChangeSummary {
  counts: Record<string, number>
  eventCount: number
  overflowCount: number
  completeness?: string
}

export interface RunDetailProjection {
  activities: readonly RunActivitySnapshot[]
  /** Safe activities dropped by the snapshot's rolling window. */
  omittedActivityCount: number
  /** Everything that is NOT a verification run. */
  artifacts: readonly RunArtifactSnapshot[]
  verifications: readonly VerificationArtifact[]
  changes: readonly RunChangeEntry[]
  changeSummary?: RunChangeSummary
}

/** An artifact the producer typed as a verification, with its counts present. */
export interface VerificationArtifact extends RunArtifactSnapshot {
  verification: RunVerificationSummary
}

function isVerification(artifact: RunArtifactSnapshot): artifact is VerificationArtifact {
  return artifact.kind === "verification" && artifact.verification !== undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function changeFrom(event: RunEvent): RunChangeEntry | undefined {
  const path = str(event.payload.path)
  // The connector runtime writes `resource.changed` for its SDK-session anchor,
  // which has a `resourceId` and no path. It is a recovery marker, not a file,
  // and listing it under Changes would report a file change that never happened.
  if (!path) return undefined
  return {
    path,
    ...(str(event.payload.oldPath) ? { oldPath: str(event.payload.oldPath) } : {}),
    ...(str(event.payload.kind) ? { changeKind: str(event.payload.kind) } : {}),
    ...(str(event.payload.origin) ? { origin: str(event.payload.origin) } : {}),
    sensitive: event.payload.sensitive === true,
  }
}

function summaryFrom(event: RunEvent): RunChangeSummary | undefined {
  const raw = event.payload.counts
  const counts: Record<string, number> = {}
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) counts[key] = value
    }
  }
  const eventCount = event.payload.eventCount
  const overflowCount = event.payload.overflowCount
  return {
    counts,
    eventCount: typeof eventCount === "number" ? eventCount : 0,
    overflowCount: typeof overflowCount === "number" ? overflowCount : 0,
    ...(str(event.payload.completeness) ? { completeness: str(event.payload.completeness) } : {}),
  }
}

export function projectRunDetail(
  snapshot: RunProjectionSnapshot | undefined,
  events: readonly RunEvent[]
): RunDetailProjection {
  const allArtifacts = snapshot?.artifacts ?? []
  const changes: RunChangeEntry[] = []
  const seenPaths = new Set<string>()
  let changeSummary: RunChangeSummary | undefined

  for (const event of events) {
    if (event.type === "resource.changed") {
      const change = changeFrom(event)
      // One file touched ten times is one changed file, and the LAST record is
      // the one that describes where it ended up.
      if (change) {
        if (seenPaths.has(change.path)) {
          const index = changes.findIndex((entry) => entry.path === change.path)
          changes[index] = change
        } else {
          seenPaths.add(change.path)
          changes.push(change)
        }
      }
      continue
    }
    // Last summary wins: a run that reports twice has revised its own tally.
    if (event.type === "resource.summary") changeSummary = summaryFrom(event)
  }

  return {
    activities: snapshot?.activities ?? [],
    omittedActivityCount: snapshot?.omittedActivityCount ?? 0,
    artifacts: allArtifacts.filter((artifact) => !isVerification(artifact)),
    verifications: allArtifacts.filter(isVerification),
    changes,
    ...(changeSummary ? { changeSummary } : {}),
  }
}

/**
 * The i18n label key for a change kind, from a closed set.
 *
 * `ResourceEventKind` has seven members — `any`, `gap` and `resync` alongside
 * the four obvious ones — and the key is interpolated, so no lint would catch a
 * missing entry: it would simply render `gap` to the user. Unknown values fall
 * back to `other`.
 */
const CHANGE_KIND_KEYS = new Set([
  "created",
  "modified",
  "deleted",
  "renamed",
  "any",
  "gap",
  "resync",
])

/** Every key {@link changeKindLabelKey} can return. */
export const CHANGE_KIND_LABEL_KEYS: readonly string[] = Object.freeze([
  ...CHANGE_KIND_KEYS,
  "other",
])

export function changeKindLabelKey(kind: string | undefined): string | undefined {
  if (!kind) return undefined
  return CHANGE_KIND_KEYS.has(kind) ? kind : "other"
}

/**
 * Whether a change list can be trusted as complete.
 *
 * False when the producer said it overflowed, or reported anything other than
 * `"complete"` (`ResourceTimelineCompleteness` also has `resyncRequired` and
 * `reconciled`, both of which mean the timeline had a gap). The cockpit says so
 * out loud rather than presenting a partial list as the whole truth — the same
 * rule the Strix runner already follows for an unreadable artifact.
 *
 * A missing summary counts as complete only because the sole producer
 * (`projectTaskWorkspaceRun`) always writes one after its change events: no
 * summary therefore means no tracked workspace, not a lost tally.
 */
export function changesAreComplete(summary: RunChangeSummary | undefined): boolean {
  if (!summary) return true
  if (summary.overflowCount > 0) return false
  return summary.completeness === undefined || summary.completeness === "complete"
}
