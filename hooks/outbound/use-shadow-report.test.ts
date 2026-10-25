/** @jest-environment jsdom */

import type { ActionReviewReceipt } from "@cognia/agent-config-types/action-review"
import { toReceiptRow } from "@/lib/db/action-review-receipts"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  conversationTarget,
  mailTarget,
  toReviewTarget,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getAllTasks: async () => [{ id: "t1", name: "Morning digest" }] },
}))

import { loadShadowReport } from "./use-shadow-report"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const KNOWN = conversationTarget("lark:bot-a:oc_known")!
const BOUND = conversationTarget("lark:bot-a:oc_bound")!
const LISTED_MAIL = mailTarget("ops@example.com")!
const STRANGER = conversationTarget("lark:bot-a:oc_stranger")!

function receipt(root: string, target: OutboundTarget, enforced = false): ActionReviewReceipt {
  const requestId = crypto.randomUUID()
  return {
    id: requestId,
    request: {
      contractVersion: 1,
      requestId,
      origin: { channel: "chat-tool", scope: "chat", id: requestId, rootSessionId: root },
      subject: { kind: "tool-call", ref: "im_send", targets: [toReviewTarget(target)] },
      verdict: "ask",
      verdictExplicit: false,
      tier: "medium",
      surfaces: [],
      plan: { outcome: "draft", enforced },
      requestedAt: 1,
    },
    decision: {
      contractVersion: 1,
      requestId,
      outcome: "allow",
      authority: "policy-default",
      decidedAt: 10,
    },
  } as unknown as ActionReviewReceipt
}

describe("loadShadowReport", () => {
  it("names recipients from what the device holds, and the senders and accounts", async () => {
    const db = getDb()
    await db.actionReviewReceipts.bulkPut(
      [
        receipt("task:t1", KNOWN),
        receipt("task:t1", BOUND),
        receipt("task:t1", STRANGER),
        receipt("bot:boti_1", LISTED_MAIL),
        // Enforced plans are not shadow observations.
        receipt("task:t1", KNOWN, true),
      ].map(toReceiptRow)
    )
    await db.connectorConversationStates.put({
      conversationKey: "lark:bot-a:oc_known",
      adapterId: "bot-a",
    } as never)
    await db.sessions.put({
      id: "s1",
      title: "Ops room",
      platformBinding: { conversationKey: "lark:bot-a:oc_bound:om_thread" },
    } as never)
    await db.adapterInstances.put({ id: "bot-a", displayName: "Team bot", type: "lark" } as never)
    // The Bot's own list names the address; its runs are granted it, a task's are not.
    await db.botInstallations.put({
      id: "boti_1",
      outboundRecipients: [{ recipient: LISTED_MAIL, addedAt: 1, addedBy: "local-user" }],
    } as never)
    await db.actionReviewReceipts.put(toReceiptRow(receipt("task:t1", LISTED_MAIL)))

    const view = await loadShadowReport()
    expect(view.taskNames.get("t1")).toBe("Morning digest")
    expect(view.adapterNames.get("bot-a")).toBe("Team bot")
    expect(view.conversationTitles.get(BOUND.recipient)).toBe("Ops room")

    expect(view.report.groups.map((group) => group.sender)).toEqual([{ kind: "task", id: "t1" }])
    const [task] = view.report.groups
    expect(task.rows.map((row) => row.target.recipient).sort()).toEqual(
      [KNOWN.recipient, BOUND.recipient, LISTED_MAIL.recipient].sort()
    )
    expect(task.unrecognized).toEqual([
      expect.objectContaining({ channel: "bot-a", recipients: 1, sends: 1 }),
    ])
    expect(view.report.sends).toBe(4)
  })

  it("reports nothing when nothing was held", async () => {
    const view = await loadShadowReport()
    expect(view.report).toEqual({ groups: [], totals: {}, sends: 0 })
  })
})
