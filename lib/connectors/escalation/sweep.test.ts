/**
 * @jest-environment jsdom
 */

/**
 * Sweep semantics against fake-indexeddb rows. Actions are injected so the
 * suite pins WHEN steps fire; `actions.test.ts` pins WHAT each action does.
 * The `notify` action is exercised end-to-end through the real
 * `runEscalationAction` with the Notification Center runtime mocked.
 */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  markResponded,
  readForResolution,
  setStatus,
  upsertByConversationKey,
} from "@/lib/db/conversation-overrides"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { EscalationAction, EscalationPolicy } from "@/types/connectors/escalation"
import type { EscalationActionContext } from "./actions"

const mockNotify = jest.fn(async () => "n1")
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...a: unknown[]) => mockNotify(...(a as [])),
}))
// The bus / gateway are only reached by `urgent`; keep them out of jsdom.
jest.mock("@/lib/connectors/bus", () => ({ getBus: jest.fn() }))
jest.mock("@/lib/connectors/delivery-gateway", () => ({ enqueueGoverned: jest.fn() }))

import { resolveEscalationPolicy, sweepSlaEscalations } from "./sweep"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  mockNotify.mockClear()
})
afterAll(dbFixture.dispose)

const ADAPTER = "adp_sla"
const KEY = `telegram:${ADAPTER}:chat_1`
const NOW = 10_000_000

const POLICY: EscalationPolicy = {
  steps: [
    { afterOverdueMinutes: 0, actions: [{ type: "notify" }] },
    { afterOverdueMinutes: 30, actions: [{ type: "switchMode", mode: "manual" }] },
  ],
}

async function seedAdapter(over: Partial<AdapterInstanceRow> = {}): Promise<void> {
  await getDb().adapterInstances.add({
    id: ADAPTER,
    type: "telegram",
    displayName: "Bot",
    enabled: true,
    transportMode: "long-poll",
    settings: {},
    credentialsRef: { keyringService: "t", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as AdapterInstanceRow)
}

const okAction = () =>
  jest.fn(async (_ctx: EscalationActionContext, _action: EscalationAction) => ({
    ok: true as const,
  }))

const audits = (kind?: string) =>
  getDb()
    .connectorAudit.filter((r) => r.conversationKey === KEY && (!kind || r.kind === kind))
    .toArray()

describe("resolveEscalationPolicy", () => {
  it("prefers the override, then the adapter default, else none", () => {
    const p = { steps: [] }
    expect(resolveEscalationPolicy({ escalation: p }, { defaultEscalation: POLICY })).toEqual({
      policy: p,
      source: "override",
    })
    expect(resolveEscalationPolicy({}, { defaultEscalation: POLICY })).toEqual({
      policy: POLICY,
      source: "adapter-default",
    })
    expect(resolveEscalationPolicy({}, undefined)).toEqual({ policy: undefined, source: "none" })
  })
})

describe("sweepSlaEscalations", () => {
  it("fires step 0 once at the deadline, step 1 later, and audits each step", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
    })
    const runAction = okAction()

    // Tick 1: 1 min overdue → only step 0.
    let result = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(result).toEqual({ scanned: 1, escalated: 1, actions: 1, failures: 0, errors: 0 })
    expect(runAction).toHaveBeenCalledTimes(1)
    expect(runAction.mock.calls[0][0]).toMatchObject({
      conversationKey: KEY,
      stepIndex: 0,
      overdueMinutes: 1,
      adapter: expect.objectContaining({ id: ADAPTER }),
    })
    expect(runAction.mock.calls[0][1]).toEqual({ type: "notify" })
    let row = await readForResolution(KEY)
    expect(row?.escalatedStep).toBe(0)
    expect(row?.escalatedAt).toBe(NOW)

    // Tick 2 (same minute): nothing new fires — each step fires once.
    result = await sweepSlaEscalations({ now: () => NOW + 1_000, runAction })
    expect(result.escalated).toBe(0)
    expect(runAction).toHaveBeenCalledTimes(1)

    // Tick 3: 31 min overdue → step 1.
    result = await sweepSlaEscalations({ now: () => NOW + 30 * 60_000, runAction })
    expect(result.escalated).toBe(1)
    expect(runAction).toHaveBeenCalledTimes(2)
    expect(runAction.mock.calls[1][0]).toMatchObject({ stepIndex: 1, overdueMinutes: 31 })
    row = await readForResolution(KEY)
    expect(row?.escalatedStep).toBe(1)

    const escalated = (await audits("sla.escalated")).sort(
      (a, b) => Number(a.fields?.step) - Number(b.fields?.step)
    )
    expect(escalated).toHaveLength(2)
    expect(escalated[0]).toMatchObject({
      adapterId: ADAPTER,
      fields: {
        step: 0,
        afterOverdueMinutes: 0,
        overdueMinutes: 1,
        actions: ["notify"],
        failed: [],
        policySource: "override",
      },
    })
    expect(escalated[1].fields).toMatchObject({ step: 1, actions: ["switchMode"] })
  })

  it("fires several due steps in one tick when the sweep was away", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 90 * 60_000,
      escalation: POLICY,
    })
    const runAction = okAction()
    const result = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(result.escalated).toBe(2)
    expect(runAction.mock.calls.map((c) => c[0].stepIndex)).toEqual([0, 1])
    expect((await readForResolution(KEY))?.escalatedStep).toBe(1)
  })

  it("does not fire after markResponded and restarts the chain on the next breach", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
    })
    const runAction = okAction()
    await sweepSlaEscalations({ now: () => NOW, runAction })
    expect((await readForResolution(KEY))?.escalatedStep).toBe(0)

    await markResponded(KEY, NOW + 1)
    // Deadline cleared → not selected at all.
    const quiet = await sweepSlaEscalations({ now: () => NOW + 60 * 60_000, runAction })
    expect(quiet.scanned).toBe(0)
    expect(runAction).toHaveBeenCalledTimes(1)

    // A new breach starts from step 0 again (markResponded reset escalatedStep).
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW + 2 * 60 * 60_000,
    })
    await sweepSlaEscalations({ now: () => NOW + 2 * 60 * 60_000 + 1, runAction })
    expect(runAction).toHaveBeenCalledTimes(2)
    expect(runAction.mock.calls[1][0].stepIndex).toBe(0)
  })

  it("skips resolved and snoozed conversations and rows that are not yet due", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
      status: "resolved",
    })
    await upsertByConversationKey({
      conversationKey: `telegram:${ADAPTER}:chat_snoozed`,
      sessionId: "s2",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
      status: "snoozed",
      snoozeUntil: NOW + 1,
    })
    await upsertByConversationKey({
      conversationKey: `telegram:${ADAPTER}:chat_future`,
      sessionId: "s3",
      nextResponseDueAt: NOW + 60_000,
      escalation: POLICY,
    })
    const runAction = okAction()
    const result = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(result).toEqual({ scanned: 0, escalated: 0, actions: 0, failures: 0, errors: 0 })
    expect(runAction).not.toHaveBeenCalled()

    // Reopen via setStatus → the row is eligible again (resolve reset the chain).
    await setStatus(KEY, "open")
    const reopened = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(reopened.escalated).toBe(1)
  })

  it("falls back to the adapter default policy and labels the source", async () => {
    await seedAdapter({ defaultEscalation: POLICY })
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
    })
    const runAction = okAction()
    const result = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(result.escalated).toBe(1)
    expect((await audits("sla.escalated"))[0].fields?.policySource).toBe("adapter-default")

    // An explicit empty override turns escalation OFF even with an adapter default.
    await upsertByConversationKey({
      conversationKey: `telegram:${ADAPTER}:chat_off`,
      sessionId: "s2",
      nextResponseDueAt: NOW - 60_000,
      escalation: { steps: [] },
    })
    const off = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(off.escalated).toBe(0)
  })

  it("skips rows with no policy, an unknown adapter, or an unparseable key", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
    })
    await upsertByConversationKey({
      conversationKey: "telegram:ghost:chat",
      sessionId: "s2",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
    })
    await upsertByConversationKey({
      conversationKey: "opaque",
      sessionId: "s3",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
    })
    const runAction = okAction()
    const result = await sweepSlaEscalations({ now: () => NOW, runAction })
    expect(result).toEqual({ scanned: 3, escalated: 0, actions: 0, failures: 0, errors: 0 })
  })

  it("audits a failed action (urgent outside Lark), keeps the chain going, and still records the step", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
      escalation: {
        steps: [
          {
            afterOverdueMinutes: 0,
            actions: [{ type: "urgent", userIds: ["ou_1"] }, { type: "notify" }],
          },
        ],
      },
    })
    // Real `runEscalationAction`: urgent → unsupported_platform on telegram,
    // notify → mocked Notification Center.
    const result = await sweepSlaEscalations({ now: () => NOW })
    expect(result).toEqual({ scanned: 1, escalated: 1, actions: 2, failures: 1, errors: 0 })
    expect(mockNotify).toHaveBeenCalledTimes(1)
    const failed = await audits("sla.escalation_action_failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      adapterId: ADAPTER,
      reason: "unsupported_platform",
      fields: { step: 0, actionIndex: 0, action: "urgent", policySource: "override" },
    })
    const escalated = await audits("sla.escalated")
    expect(escalated[0].fields).toMatchObject({
      actions: ["urgent", "notify"],
      failed: [{ action: "urgent", reason: "unsupported_platform" }],
    })
    expect((await readForResolution(KEY))?.escalatedStep).toBe(0)
  })

  it("re-reads the row between actions so a reassign is visible to the next action", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
      escalation: {
        steps: [
          {
            afterOverdueMinutes: 0,
            actions: [{ type: "reassign", assignee: { kind: "human" } }, { type: "notify" }],
          },
        ],
      },
    })
    const seen: unknown[] = []
    const runAction = jest.fn(
      async (ctx: { row: { assignee?: unknown } }, action: { type: string }) => {
        seen.push(ctx.row.assignee ?? null)
        if (action.type === "reassign") {
          await getDb()
            .conversationOverrides.where("conversationKey")
            .equals(KEY)
            .modify({ assignee: { kind: "human" } })
        }
        return { ok: true as const }
      }
    )
    await sweepSlaEscalations({ now: () => NOW, runAction: runAction as never })
    expect(seen).toEqual([null, { kind: "human" }])
  })

  it("uses the wall clock by default and survives an action deleting the row / throwing a non-Error", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: Date.now() - 60_000,
      escalation: POLICY,
    })
    await upsertByConversationKey({
      conversationKey: `telegram:${ADAPTER}:chat_gone`,
      sessionId: "s2",
      nextResponseDueAt: Date.now() - 60_000,
      escalation: POLICY,
    })
    const runAction = jest.fn(async (ctx: { conversationKey: string }) => {
      if (ctx.conversationKey === KEY) throw "string failure"
      // Delete the row mid-step: the sweep falls back to the pre-action row.
      await getDb()
        .conversationOverrides.where("conversationKey")
        .equals(ctx.conversationKey)
        .delete()
      return { ok: true as const }
    })
    const result = await sweepSlaEscalations({ runAction: runAction as never })
    expect(result.errors).toBe(1)
    expect(result.escalated).toBe(1)
  })

  it("isolates a throwing row and keeps sweeping the others", async () => {
    await seedAdapter()
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
    })
    await upsertByConversationKey({
      conversationKey: `telegram:${ADAPTER}:chat_ok`,
      sessionId: "s2",
      nextResponseDueAt: NOW - 60_000,
      escalation: POLICY,
    })
    const runAction = jest.fn(async (ctx: { conversationKey: string }) => {
      if (ctx.conversationKey === KEY) throw new Error("kaboom")
      return { ok: true as const }
    })
    const result = await sweepSlaEscalations({ now: () => NOW, runAction: runAction as never })
    expect(result.errors).toBe(1)
    expect(result.escalated).toBe(1)
    expect((await readForResolution(`telegram:${ADAPTER}:chat_ok`))?.escalatedStep).toBe(0)
    expect((await readForResolution(KEY))?.escalatedStep).toBeUndefined()
  })
})
