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
 * and the recipient is a conversation, a mail address or a repository, and
 * otherwise the bot account's list (members are named within an account) or,
 * for a repository, the list of the GitHub integration account the write went
 * through. A receipt names that account when the write had one; a `gh`
 * command or a stack publish has none, so the person picks among the accounts
 * on the repository's host (`allowChoices`). A row whose recipient a list now
 * holds is dropped: enforcement would let it through.
 *
 * Each category (messaging, GitHub, the browser) has its own mode, so the
 * report is split by category and each is read on its own. A person's own
 * write (a human receipt) plans `allow` and is never in it.
 *
 * Pure: reads only its arguments.
 */

import type {
  ActionReviewPlanOutcome,
  ActionReviewReceipt,
  OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"

import {
  OUTBOUND_CATEGORIES,
  outboundCategoryOf,
  outboundFingerprint,
  type OutboundCategory,
  type OutboundTarget,
} from "./outbound-targets"

export type ShadowSenderKind =
  "bot" | "task" | "workflow" | "notification" | "plugin" | "team" | "chat" | "other"

export interface ShadowSender {
  kind: ShadowSenderKind
  /** The installation, task, workflow, plugin, team or session id; the raw ref for `other`. */
  id: string
}

/** The outcomes enforcement would change: everything but `allow`. */
export type ShadowHeldOutcome = Exclude<ActionReviewPlanOutcome, "allow">

export type ShadowAllowInto =
  | { kind: "bot"; installationId: string }
  | { kind: "adapter"; adapterId: string }
  | { kind: "integration-account"; pluginId: string; accountId: string }

export interface ShadowRecipientRow {
  channel: string
  fingerprint: string
  target: OutboundTarget
  sends: number
  lastAt: number
  outcomes: Partial<Record<ShadowHeldOutcome, number>>
  /** The list "allow this recipient" writes; absent when no list may hold it. */
  allowInto?: ShadowAllowInto
  /**
   * When the write named no account and several GitHub accounts could hold
   * the repository: the lists a person picks from. Absent with `allowInto`.
   */
  allowChoices?: ShadowAllowInto[]
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

export interface ShadowCategoryReport {
  groups: ShadowSenderGroup[]
  /** Sends enforcement would change, by what it would do instead. */
  totals: Partial<Record<ShadowHeldOutcome, number>>
  sends: number
}

/**
 * One report per category, since each is enforced on its own. A receipt with
 * targets in two categories (a `gh api` call, rarely) counts in both.
 */
export type ShadowReport = Record<OutboundCategory, ShadowCategoryReport>

/** A GitHub integration account and the repositories its list holds. */
export interface ShadowGithubAccount {
  pluginId: string
  /** Its web host (`githubWebHost`); absent is github.com. */
  host?: string
  list: readonly OutboundRecipientGrant[]
}

export interface ShadowReportInput {
  receipts: readonly ActionReviewReceipt[]
  /** Recipients this device can name, in the engine's normalized form. */
  candidates: readonly OutboundTarget[]
  /** Every Bot installation's list, keyed by installation id (empty when it has none). */
  botLists: ReadonlyMap<string, readonly OutboundRecipientGrant[]>
  /** Every connector instance's list, keyed by adapter id (empty when it has none). */
  adapterLists: ReadonlyMap<string, readonly OutboundRecipientGrant[]>
  /** Every GitHub integration account, keyed by account id. Absent: none. */
  githubAccounts?: ReadonlyMap<string, ShadowGithubAccount>
}

/** Who sent what a receipt reviewed: the run's root, else the delivery's owner. */
export function shadowSenderOf(receipt: ActionReviewReceipt): ShadowSender {
  const root = receipt.request.origin.rootSessionId
  const fromRoot = root ? prefixed(root) : undefined
  if (fromRoot && fromRoot.kind !== "other") return fromRoot
  const kind = receipt.request.subject.kind
  if (kind === "connector-delivery" || kind === "integration-action") {
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
    case "agent-team":
      return { kind: "team", id }
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

function categoryOfChannel(channel: string): OutboundCategory {
  return outboundCategoryOf({ kind: "unknown", channel })
}

/** The GitHub account the receipt's write went through, when it names a known one. */
export function shadowReceiptAccount(
  receipt: ActionReviewReceipt,
  accounts: ReadonlyMap<string, ShadowGithubAccount> | undefined
): string | undefined {
  const named = receipt.request.subject.input?.integrationAccount
  if (!named || typeof named !== "object") return undefined
  const accountId = (named as { accountId?: unknown }).accountId
  return typeof accountId === "string" && accounts?.has(accountId) ? accountId : undefined
}

/** `github:<host>/<owner>/<repo>` → its host. */
function repositoryHost(target: OutboundTarget): string | undefined {
  if (target.kind !== "repository") return undefined
  const rest = target.recipient.slice("github:".length)
  const slash = rest.indexOf("/")
  return slash > 0 ? rest.slice(0, slash) : undefined
}

function accountInto(accountId: string, account: ShadowGithubAccount): ShadowAllowInto {
  return { kind: "integration-account", pluginId: account.pluginId, accountId }
}

interface AllowLists {
  allowInto?: ShadowAllowInto
  allowChoices?: ShadowAllowInto[]
}

function allowIntoFor(
  sender: ShadowSender,
  target: OutboundTarget,
  input: ShadowReportInput,
  accountId: string | undefined
): AllowLists {
  if (
    sender.kind === "bot" &&
    input.botLists.has(sender.id) &&
    (target.kind === "conversation" || target.kind === "mail" || target.kind === "repository")
  ) {
    return { allowInto: { kind: "bot", installationId: sender.id } }
  }
  if (target.kind === "repository") {
    const accounts = input.githubAccounts ?? new Map<string, ShadowGithubAccount>()
    const named = accountId ? accounts.get(accountId) : undefined
    if (accountId && named) return { allowInto: accountInto(accountId, named) }
    // No account named: every account on the repository's host could hold it.
    const host = repositoryHost(target)
    const onHost = [...accounts].filter(([, account]) => (account.host ?? "github.com") === host)
    if (onHost.length === 1) return { allowInto: accountInto(onHost[0][0], onHost[0][1]) }
    if (onHost.length > 1) {
      return { allowChoices: onHost.map(([id, account]) => accountInto(id, account)) }
    }
    return {}
  }
  if (
    (target.kind === "conversation" || target.kind === "person") &&
    input.adapterLists.has(target.channel)
  ) {
    return { allowInto: { kind: "adapter", adapterId: target.channel } }
  }
  return {}
}

/** Whether a list that applies to this send already holds the recipient. */
function coveredNow(
  sender: ShadowSender,
  fingerprint: string,
  channel: string,
  accountId: string | undefined,
  input: ShadowReportInput
): boolean {
  if (sender.kind === "bot" && fingerprints(input.botLists.get(sender.id)).has(fingerprint)) {
    return true
  }
  if (categoryOfChannel(channel) === "github") {
    // A write through an account reads that account's list; one with no
    // account (`gh`, a stack publish) reads every GitHub account's.
    const accounts = input.githubAccounts ?? new Map<string, ShadowGithubAccount>()
    const lists = accountId
      ? [accounts.get(accountId)?.list]
      : [...accounts.values()].map((account) => account.list)
    return lists.some((list) => fingerprints(list).has(fingerprint))
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
  interface PendingCategory {
    groups: Map<string, Pending>
    totals: Partial<Record<ShadowHeldOutcome, number>>
    sends: number
  }
  const categories = new Map<OutboundCategory, PendingCategory>(
    OUTBOUND_CATEGORIES.map((category) => [category, { groups: new Map(), totals: {}, sends: 0 }])
  )
  const coverage = new Map<string, boolean>()

  for (const receipt of input.receipts) {
    const outcome = heldPlan(receipt)
    const targets = receipt.request.subject.targets
    if (!outcome || !targets?.length) continue
    const sender = shadowSenderOf(receipt)
    const accountId = shadowReceiptAccount(receipt, input.githubAccounts)
    const at = receipt.decision.decidedAt
    const held = targets.filter((target) => {
      const key = `${senderKey(sender)}\u0000${accountId ?? ""}\u0000${target.fingerprint}`
      if (!coverage.has(key)) {
        coverage.set(key, coveredNow(sender, target.fingerprint, target.channel, accountId, input))
      }
      return !coverage.get(key)
    })

    for (const [category, pending] of categories) {
      const inCategory = held.filter((ref) => categoryOfChannel(ref.channel) === category)
      if (inCategory.length === 0) continue

      const key = senderKey(sender)
      let group = pending.groups.get(key)
      if (!group) {
        group = { sender, rows: new Map(), unrecognized: new Map(), sends: 0, lastAt: 0 }
        pending.groups.set(key, group)
      }
      group.sends += 1
      group.lastAt = Math.max(group.lastAt, at)
      bump(pending.totals, outcome)
      pending.sends += 1

      for (const ref of inCategory) {
        const target = named.get(ref.fingerprint)
        if (target) {
          let row = group.rows.get(ref.fingerprint)
          if (!row) {
            row = {
              channel: ref.channel,
              fingerprint: ref.fingerprint,
              target,
              sends: 0,
              lastAt: 0,
              outcomes: {},
              ...allowIntoFor(sender, target, input, accountId),
            }
            group.rows.set(ref.fingerprint, row)
          } else if (!row.allowInto && accountId) {
            // A later write named the account the earlier ones did not.
            const lists = allowIntoFor(sender, target, input, accountId)
            if (lists.allowInto) {
              row.allowInto = lists.allowInto
              delete row.allowChoices
            }
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
  }

  const byRecent = (a: { lastAt: number }, b: { lastAt: number }) => b.lastAt - a.lastAt
  const report = {} as ShadowReport
  for (const [category, pending] of categories) {
    report[category] = {
      groups: [...pending.groups.values()]
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
      totals: pending.totals,
      sends: pending.sends,
    }
  }
  return report
}
