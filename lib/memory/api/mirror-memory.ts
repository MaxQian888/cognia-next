/**
 * The local half of a mobile memory mutation.
 *
 * The phone is queue-first: the mutation enters the durable outbound queue,
 * the desktop applies the authoritative write (`updateExternalMemory` /
 * `forgetExternalMemory`, with the policy, PII, evidence, vector and tombstone
 * lifecycle), and this module updates the local mirror so the UI does not sit
 * on stale rows until the next sync pull.
 *
 * What it deliberately does NOT do is repeat the desktop's work. A phone has no
 * vector sink, and a tombstone is written by the authority, not by a mirror. So
 * a local vector call would fail by construction and a local tombstone would be
 * a second, competing claim about a deletion the phone did not perform. What it
 * DOES reuse is the part a mirror is allowed to own: field validation, the
 * version bump, and one audit row saying the mirror moved.
 *
 * Before this module the three handlers wrote raw Dexie with none of that.
 */

import { invalidateMemory, setMemoryPinned, updateMemory } from "@/lib/db/memories"
import { appendMemoryAuditEvent } from "@/lib/db/memory-governance"

export type MirroredMemoryMutation =
  | { kind: "update"; id: string; patch: { text?: string; pinned?: boolean } }
  | { kind: "forget"; id: string }

export interface MirroredMemoryResult {
  ok: boolean
  reason?: "empty_patch" | "failed"
}

/**
 * Apply one queued mutation to the local mirror.
 *
 * Never throws: the authoritative write is already queued, so a mirror failure
 * must not surface as a failed user action. The next `syncMemories` pull
 * reconciles whatever the mirror got wrong.
 */
export async function applyMirroredMemoryMutation(
  mutation: MirroredMemoryMutation
): Promise<MirroredMemoryResult> {
  try {
    if (mutation.kind === "forget") {
      await invalidateMemory(mutation.id)
      await auditMirror(mutation.id, "invalidated")
      return { ok: true }
    }

    const { text, pinned } = mutation.patch
    if (text === undefined && pinned === undefined) return { ok: false, reason: "empty_patch" }

    if (pinned !== undefined) {
      await setMemoryPinned(mutation.id, pinned)
      await auditMirror(mutation.id, pinned ? "pinned" : "unpinned")
    }
    if (text !== undefined) {
      // `bumpVersion` matches what the desktop authority does, so the mirror
      // does not look older than the row it is mirroring.
      await updateMemory(mutation.id, { text, bumpVersion: true })
      await auditMirror(mutation.id, "revised")
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: "failed" }
  }
}

async function auditMirror(
  memoryId: string,
  action: "revised" | "pinned" | "unpinned" | "invalidated"
): Promise<void> {
  await appendMemoryAuditEvent({ action, memoryId, reason: "mobile_mirror" }).catch(() => undefined)
}
