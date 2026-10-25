import type {
  ActionReviewPlanOutcome,
  ActionReviewReceipt,
  OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"

import {
  conversationTarget,
  mailTarget,
  outboundFingerprint,
  personTarget,
  toReviewTarget,
  type OutboundTarget,
} from "./outbound-targets"
import { buildShadowReport, shadowSenderOf } from "./shadow-report"

const CHAT = conversationTarget("lark:bot-a:oc_1")!
const OTHER_CHAT = conversationTarget("lark:bot-a:oc_2")!
const MEMBER = personTarget("bot-a", "ou_1")!
const MAIL = mailTarget("ops@example.com")!
const STRANGER = conversationTarget("lark:bot-a:oc_unknown")!

function receipt(
  over: {
    root?: string
    kind?: "tool-call" | "connector-delivery" | "integration-action"
    ref?: string
    targets?: OutboundTarget[]
    outcome?: ActionReviewPlanOutcome
    enforced?: boolean
    at?: number
    plan?: false
  } = {}
): ActionReviewReceipt {
  return {
    id: crypto.randomUUID(),
    request: {
      origin: { channel: "chat-tool", scope: "chat", id: "x", rootSessionId: over.root },
      subject: {
        kind: over.kind ?? "tool-call",
        ref: over.ref ?? "im_send",
        targets: (over.targets ?? [CHAT]).map(toReviewTarget),
      },
      ...(over.plan === false
        ? {}
        : { plan: { outcome: over.outcome ?? "draft", enforced: over.enforced ?? false } }),
    },
    decision: { decidedAt: over.at ?? 1 },
  } as unknown as ActionReviewReceipt
}

function grant(target: OutboundTarget): OutboundRecipientGrant {
  return {
    recipient: target as OutboundRecipientGrant["recipient"],
    addedAt: 1,
    addedBy: "local-user",
  }
}

const EMPTY = {
  candidates: [CHAT, OTHER_CHAT, MEMBER, MAIL],
  botLists: new Map([["boti_1", []]]),
  adapterLists: new Map([["bot-a", []]]),
}

describe("shadowSenderOf", () => {
  it("names the run's root first, then the delivery's owner, then the chat", () => {
    expect(shadowSenderOf(receipt({ root: "bot:boti_1" }))).toEqual({ kind: "bot", id: "boti_1" })
    expect(shadowSenderOf(receipt({ root: "task:t1" }))).toEqual({ kind: "task", id: "t1" })
    expect(shadowSenderOf(receipt({ root: "workflow-run:r1" }))).toEqual({
      kind: "workflow",
      id: "r1",
    })
    expect(shadowSenderOf(receipt({ kind: "connector-delivery", ref: "notification:n1" }))).toEqual(
      { kind: "notification", id: "n1" }
    )
    expect(shadowSenderOf(receipt({ kind: "connector-delivery", ref: "plugin:acme" }))).toEqual({
      kind: "plugin",
      id: "acme",
    })
    // A GitHub write through the integration broker names its asker the same way.
    expect(shadowSenderOf(receipt({ kind: "integration-action", ref: "plugin:gh" }))).toEqual({
      kind: "plugin",
      id: "gh",
    })
    expect(shadowSenderOf(receipt({ kind: "integration-action", ref: "bot:boti_2" }))).toEqual({
      kind: "bot",
      id: "boti_2",
    })
    expect(shadowSenderOf(receipt({ kind: "connector-delivery", ref: "digest:t9" }))).toEqual({
      kind: "task",
      id: "t9",
    })
    expect(shadowSenderOf(receipt({ root: "session-1" }))).toEqual({
      kind: "chat",
      id: "session-1",
    })
    expect(
      shadowSenderOf(receipt({ kind: "connector-delivery", ref: "digest:lark:bot-a:oc_1" }))
    ).toEqual({ kind: "other", id: "digest:lark:bot-a:oc_1" })
  })
})

describe("buildShadowReport", () => {
  it("folds held plans into one row per sender and recipient, counting outcomes", () => {
    const report = buildShadowReport({
      ...EMPTY,
      receipts: [
        receipt({ root: "task:t1", outcome: "draft", at: 5 }),
        receipt({ root: "task:t1", outcome: "park", at: 9 }),
        receipt({ root: "task:t1", targets: [OTHER_CHAT], outcome: "draft", at: 7 }),
        receipt({ root: "bot:boti_1", targets: [MAIL], outcome: "ask", at: 3 }),
      ],
    })
    expect(report.sends).toBe(4)
    expect(report.totals).toEqual({ draft: 2, park: 1, ask: 1 })
    expect(report.groups.map((group) => group.sender)).toEqual([
      { kind: "task", id: "t1" },
      { kind: "bot", id: "boti_1" },
    ])
    const [task, bot] = report.groups
    expect(task.rows.map((row) => [row.target.recipient, row.sends, row.outcomes])).toEqual([
      [CHAT.recipient, 2, { draft: 1, park: 1 }],
      [OTHER_CHAT.recipient, 1, { draft: 1 }],
    ])
    expect(task.rows[0].allowInto).toEqual({ kind: "adapter", adapterId: "bot-a" })
    expect(bot.rows[0].allowInto).toEqual({ kind: "bot", installationId: "boti_1" })
  })

  it("ignores allowed, enforced and planless receipts", () => {
    const report = buildShadowReport({
      ...EMPTY,
      receipts: [
        receipt({ outcome: "allow" }),
        receipt({ outcome: "draft", enforced: true }),
        receipt({ plan: false }),
        receipt({ targets: [] }),
      ],
    })
    expect(report).toEqual({ groups: [], totals: {}, sends: 0 })
  })

  it("counts recipients it cannot name per channel, without a way to allow them", () => {
    const report = buildShadowReport({
      ...EMPTY,
      receipts: [
        receipt({ root: "task:t1", targets: [STRANGER], at: 2 }),
        receipt({ root: "task:t1", targets: [STRANGER], at: 4 }),
        receipt({ root: "task:t1", targets: [personTarget("bot-a", "ou_9")!], at: 3 }),
      ],
    })
    expect(report.groups[0].rows).toEqual([])
    expect(report.groups[0].unrecognized).toEqual([
      { channel: "bot-a", recipients: 2, sends: 3, lastAt: 4 },
    ])
  })

  it("sends a Bot's members to the account's list, and offers no list for a task's mail", () => {
    const report = buildShadowReport({
      ...EMPTY,
      receipts: [
        receipt({ root: "bot:boti_1", targets: [MEMBER] }),
        receipt({ root: "task:t1", targets: [MAIL] }),
        receipt({ root: "bot:boti_gone", targets: [CHAT] }),
      ],
    })
    const into = Object.fromEntries(
      report.groups.map((group) => [group.sender.id, group.rows[0].allowInto])
    )
    expect(into).toEqual({
      boti_1: { kind: "adapter", adapterId: "bot-a" },
      t1: undefined,
      // An installation that is gone has no list; the account's still applies.
      boti_gone: { kind: "adapter", adapterId: "bot-a" },
    })
  })

  it("drops what a list now holds, so the totals are what enforcement would still change", () => {
    const report = buildShadowReport({
      ...EMPTY,
      botLists: new Map([["boti_1", [grant(MAIL)]]]),
      adapterLists: new Map([["bot-a", [grant(CHAT)]]]),
      receipts: [
        receipt({ root: "task:t1", targets: [CHAT] }),
        receipt({ root: "bot:boti_1", targets: [MAIL] }),
        // The Bot's list grants only its own runs.
        receipt({ root: "task:t1", targets: [MAIL] }),
        receipt({ root: "task:t1", targets: [CHAT, OTHER_CHAT] }),
      ],
    })
    expect(report.sends).toBe(2)
    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].rows.map((row) => outboundFingerprint(row.target)).sort()).toEqual(
      [outboundFingerprint(MAIL), outboundFingerprint(OTHER_CHAT)].sort()
    )
  })
})
