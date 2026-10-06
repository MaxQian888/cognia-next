/**
 * An issue's deliverables: what its runs' agents linked as results
 * (`IssueRunArtifact.deliverable`), grouped into versions.
 *
 * Artifacts a run engine collects on its own (sessions, branches, pull
 * requests) are traces of the work and stay on the run card. A deliverable is
 * something an agent chose to hand over with `issue.link_artifact`. Two
 * deliverables with the same label (compared case- and space-insensitively)
 * are versions of one thing, the way a re-uploaded file with the same name
 * is: the newest is what the inspector shows, the older ones stay reachable.
 */

import { canonicalJson, sha256Hex } from "@cognia/agent"
import type {
  IssueRun,
  IssueRunArtifact,
  IssueDeliverableSnapshot,
  IssueDeliveryReceipt,
} from "@/types/issues"
import type { Artifact } from "@/types/artifact/artifact"
import type { ArtifactRow } from "@/lib/db/artifact-types"

export function deliverySnapshot(artifact: Artifact | ArtifactRow): IssueDeliverableSnapshot {
  const { lastAccessedAt: _accessed, ...metadata } = artifact.metadata ?? {}
  return JSON.parse(
    JSON.stringify({
      id: artifact.id,
      sessionId: artifact.sessionId,
      projectId: artifact.projectId,
      messageId: artifact.messageId,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      language: artifact.language,
      version: artifact.version,
      ...(artifact.metadata ? { metadata } : {}),
    })
  ) as IssueDeliverableSnapshot
}

export function deliveryDigest(
  href: string,
  receipt: Pick<IssueDeliveryReceipt, "snapshot" | "externalVersion">
): string {
  return `sha256:${sha256Hex(canonicalJson({ href, snapshot: receipt.snapshot, externalVersion: receipt.externalVersion }))}`
}

/** Only stable snapshots or explicitly versioned external references can be accepted. */
export function createDeliveryReceipt(
  href: string,
  input: Pick<IssueDeliveryReceipt, "snapshot" | "externalVersion">
): IssueDeliveryReceipt {
  if (!input.snapshot && !input.externalVersion?.trim())
    throw new Error("Delivery has no pinned version")
  const digest = deliveryDigest(href, input)
  return { ...input, id: `delivery:${digest}`, digest }
}

export function sameIssueArtifact(a: IssueRunArtifact, b: IssueRunArtifact): boolean {
  return a.href === b.href && a.delivery?.id === b.delivery?.id
}

/** The `href` scheme a Cognia artifact deliverable is stored under. */
export const ARTIFACT_HREF_PREFIX = "artifact:"

export function artifactDeliverableHref(artifactId: string): string {
  return `${ARTIFACT_HREF_PREFIX}${artifactId}`
}

/** The grouping key: label, trimmed, whitespace-collapsed, case-folded. */
export function deliverableKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

export interface IssueDeliverableVersion {
  runId: string
  artifact: IssueRunArtifact
  /** 1-based, oldest first. */
  version: number
  /** When it was linked; falls back to the run's start for rows without one. */
  linkedAt: number
}

export interface IssueDeliverable {
  key: string
  /** The newest version's label, as written. */
  label: string
  /** Newest first. */
  versions: IssueDeliverableVersion[]
}

/**
 * Group every run's deliverables. Deliverables come back newest first by
 * their latest version; versions within one are newest first too, numbered
 * from the oldest. Ties keep the order the runs and their links were made.
 */
export function groupIssueDeliverables(runs: readonly IssueRun[]): IssueDeliverable[] {
  const collected: Array<{
    runId: string
    artifact: IssueRunArtifact
    linkedAt: number
    seq: number
  }> = []
  let seq = 0
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const artifact of run.artifacts) {
      if (!artifact.deliverable) continue
      collected.push({
        runId: run.id,
        artifact,
        linkedAt: artifact.linkedAt ?? run.startedAt,
        seq: seq++,
      })
    }
  }
  collected.sort((a, b) => a.linkedAt - b.linkedAt || a.seq - b.seq)

  const byKey = new Map<string, IssueDeliverableVersion[]>()
  for (const entry of collected) {
    const key = deliverableKey(entry.artifact.label)
    const versions = byKey.get(key) ?? []
    versions.push({
      runId: entry.runId,
      artifact: entry.artifact,
      version: versions.length + 1,
      linkedAt: entry.linkedAt,
    })
    byKey.set(key, versions)
  }

  const deliverables: IssueDeliverable[] = []
  for (const [key, versions] of byKey) {
    const newestFirst = [...versions].reverse()
    deliverables.push({ key, label: newestFirst[0]!.artifact.label, versions: newestFirst })
  }
  // Newest latest-version first; a stable sort keeps link order on ties.
  return deliverables.sort((a, b) => b.versions[0]!.linkedAt - a.versions[0]!.linkedAt)
}
