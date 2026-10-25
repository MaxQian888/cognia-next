/**
 * What enforcement would change, read off the shadow-mode receipts (ADR-0239).
 *
 * In shadow mode every outbound plan is recorded and nothing about the send
 * changes. This folds the plans that were not `allow` into one row per sender
 * and recipient, so a person can grant the recipients they meant before
 * turning enforcement on, and see how many sends it would still hold.
 *
 * A receipt keeps only a channel and a fingerprint, never the recipient. A
 * recipient is named by matching the fingerprint against the ones this device
 * can name (`candidates`: its known conversations and the lists people
 * wrote); one that matches none is counted, not named, and cannot be granted
 * from here.
 *
 * "Allow this recipient" writes the sender's own list when the sender is a Bot
 * and the recipient is a conversation or a mail address, and the bot
 * account's list otherwise (members are named within an account). A row whose
 * recipient a list now holds is dropped: enforcement would let it through.
 *
 * Pure: reads only its arguments.
 */

import type {
  ActionReviewPlanOutcome,
  ActionReviewReceipt,
  OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"

import { outboundFingerprint, type OutboundTarget } from "./outbound-targets"

export type ShadowSenderKind =
  "bot" | "task" | "workflow" | "notification" | "plugin" | "chat" | "other"

export interface ShadowSender {
  kind: ShadowSenderKind
  /** The installation, task, workflow, plugin or session id; the raw ref for `other`. */
  id: string
}

/** The outcomes enforcement would change: everything but `allow`. */
export type ShadowHeldOutcome = Exclude<ActionReviewPlanOutcome, "allow">

export type ShadowAllowInto =
  { kind: "bot"; installationId: string } | { kind: "adapter"; adapterId: string }

export interface ShadowRecipientRow {
  channel: string
  fingerprint: string
  target: OutboundTarget
  sends: number
  lastAt: number
  outcomes: Partial<Record<ShadowHeldOutcome, number>>
  /** The list "allow this recipient" writes; absent when no list may hold it. */
  allowInto?: ShadowAllowInto
}

/** Recipients nothing on this device can name, per channel. */
export interface ShadowUnrecognized {
  channel: string
  recipients: number
  sends: number
  lastAt: number
}

export interface ShadowSenderGroup {
  sender: ShadowSender
  rows: ShadowRecipientRow[]
  unrecognized: ShadowUnrecognized[]
  sends: number
  lastAt: number
}

export interface ShadowReport {
  groups: ShadowSenderGroup[]
  /** Sends enforcement would change, by what it would do instead. */
  totals: Partial<Record<ShadowHeldOutcome, number>>
  sends: number
}

export interface ShadowReportInput {
  receipts: readonly ActionReviewReceipt[]
  /** Recipients this device can name, in the engine's normalized form. */
  candidates: readonly OutboundTarget[]
  /** Every Bot installation's list, keyed by installation id (empty when it has none). */
  botLists: ReadonlyMap<string, readonly OutboundRecipientGrant[]>
  /** Every connector instance's list, keyed by adapter id (empty when it has none). */
  adapterLists: ReadonlyMap<string, readonly OutboundRecipientGrant[]>
}

/** Who sent what a receipt reviewed: the run's root, else the delivery's owner. */
export function shadowSenderOf(receipt: ActionReviewReceipt): ShadowSender {
  const root = receipt.request.origin.rootSessionId
  const fromRoot = root ? prefixed(root) : undefined
  if (fromRoot && fromRoot.kind !== "other") return fromRoot
  if (receipt.request.subject.kind === "connector-delivery") {
    const fromRef = prefixed(receipt.request.subject.ref)
    if (fromRef.kind !== "other") return fromRef
  }
  // A tool call in a chat, or a delivery a chat's own turn made.
  if (root) return { kind: "chat", id: root }
  return { kind: "other", id: receipt.request.subject.ref }
}

function prefixed(ref: string): ShadowSender {
  const at = ref.indexOf(":")
  const head = at < 0 ? "" : ref.slice(0, at)
  const id = at < 0 ? ref : ref.slice(at + 1)
  switch (head) {
    case "bot":
      return { kind: "bot", id }
    case "task":
      return { kind: "task", id }
    // A digest names its task when it has one, else the conversation it digests.
    case "digest":
      return id.includes(":") ? { kind: "other", id: ref } : { kind: "task", id }
    case "workflow":
    case "workflow-run":
      return { kind: "workflow", id }
    case "notification":
      return { kind: "notification", id }
    case "plugin":
      return { kind: "plugin", id }
    default:
      return { kind: "other", id: ref }
  }
}

function senderKey(sender: ShadowSender): string {
  return `${sender.kind}\u0000${sender.id}`
}

function heldPlan(receipt: ActionReviewReceipt): ShadowHeldOutcome | undefined {
  const plan = receipt.request.plan
  if (!plan || plan.enforced || plan.outcome === "allow") return undefined
  return plan.outcome
}

function fingerprints(grants: readonly OutboundRecipientGrant[] | undefined): Set<string> {
  return new Set((grants ?? []).map((grant) => outboundFingerprint(grant.recipient)))
}

function allowIntoFor(
  sender: ShadowSender,
  target: OutboundTarget,
  input: ShadowReportInput
): ShadowAllowInto | undefined {
  if (
    sender.kind === "bot" &&
    input.botLists.has(sender.id) &&
    (target.kind === "conversation" || target.kind === "mail")
  ) {
    return { kind: "bot", installationId: sender.id }
  }
  if (
    (target.kind === "conversation" || target.kind === "person") &&
    input.adapterLists.has(target.channel)
  ) {
    return { kind: "adapter", adapterId: target.channel }
  }
  return undefined
}

/** Whether a list that applies to this send already holds the recipient. */
function coveredNow(
  sender: ShadowSender,
  fingerprint: string,
  channel: string,
  input: ShadowReportInput
): boolean {
  if (sender.kind === "bot" && fingerprints(input.botLists.get(sender.id)).has(fingerprint)) {
    return true
  }
  return fingerprints(input.adapterLists.get(channel)).has(fingerprint)
}

function bump(
  outcomes: Partial<Record<ShadowHeldOutcome, number>>,
  outcome: ShadowHeldOutcome
): void {
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
}

export function buildShadowReport(input: ShadowReportInput): ShadowReport {
  const named = new Map<string, OutboundTarget>()
  for (const target of input.candidates) named.set(outboundFingerprint(target), target)

  interface Pending {
    sender: ShadowSender
    rows: Map<string, ShadowRecipientRow>
    unrecognized: Map<string, ShadowUnrecognized & { seen: Set<string> }>
    sends: number
    lastAt: number
  }
  const groups = new Map<string, Pending>()
  const totals: Partial<Record<ShadowHeldOutcome, number>> = {}
  let sends = 0
  const coverage = new Map<string, boolean>()

  for (const receipt of input.receipts) {
    const outcome = heldPlan(receipt)
    const targets = receipt.request.subject.targets
    if (!outcome || !targets?.length) continue
    const sender = shadowSenderOf(receipt)
    const at = receipt.decision.decidedAt
    const held = targets.filter((target) => {
      const key = `${senderKey(sender)}\u0000${target.fingerprint}`
      if (!coverage.has(key)) {
        coverage.set(key, coveredNow(sender, target.fingerprint, target.channel, input))
      }
      return !coverage.get(key)
    })
    if (held.length === 0) continue

    const key = senderKey(sender)
    let group = groups.get(key)
    if (!group) {
      group = { sender, rows: new Map(), unrecognized: new Map(), sends: 0, lastAt: 0 }
      groups.set(key, group)
    }
    group.sends += 1
    group.lastAt = Math.max(group.lastAt, at)
    bump(totals, outcome)
    sends += 1

    for (const ref of held) {
      const target = named.get(ref.fingerprint)
      if (target) {
        let row = group.rows.get(ref.fingerprint)
        if (!row) {
          const allowInto = allowIntoFor(sender, target, input)
          row = {
            channel: ref.channel,
            fingerprint: ref.fingerprint,
            target,
            sends: 0,
            lastAt: 0,
            outcomes: {},
            ...(allowInto ? { allowInto } : {}),
          }
          group.rows.set(ref.fingerprint, row)
        }
        row.sends += 1
        row.lastAt = Math.max(row.lastAt, at)
        bump(row.outcomes, outcome)
      } else {
        let bucket = group.unrecognized.get(ref.channel)
        if (!bucket) {
          bucket = { channel: ref.channel, recipients: 0, sends: 0, lastAt: 0, seen: new Set() }
          group.unrecognized.set(ref.channel, bucket)
        }
        if (!bucket.seen.has(ref.fingerprint)) {
          bucket.seen.add(ref.fingerprint)
          bucket.recipients += 1
        }
        bucket.sends += 1
        bucket.lastAt = Math.max(bucket.lastAt, at)
      }
    }
  }

  const byRecent = (a: { lastAt: number }, b: { lastAt: number }) => b.lastAt - a.lastAt
  return {
    groups: [...groups.values()]
      .map((group) => ({
        sender: group.sender,
        rows: [...group.rows.values()].sort(byRecent),
        unrecognized: [...group.unrecognized.values()]
          .map(({ seen: _seen, ...bucket }) => bucket)
          .sort(byRecent),
        sends: group.sends,
        lastAt: group.lastAt,
      }))
      .sort(byRecent),
    totals,
    sends,
  }
}
