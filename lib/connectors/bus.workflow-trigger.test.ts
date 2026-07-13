/** @jest-environment jsdom */
/**
 * Verifies that `dispatchInboundFull` fans out to matching workflows after
 * routing + audit. The trigger dispatch is the M2 addition; the existing
 * pipeline tests (`bus.runtime.test.ts`) cover all other steps.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { TriggerPolicy } from "@/types/connectors/policy"

const dispatchTriggerMock = jest.fn()
const findMatchingWorkflowsMock = jest.fn()

jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  __esModule: true,
  dispatchTrigger: (...args: unknown[]) => dispatchTriggerMock(...args),
}))

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  __esModule: true,
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflowsMock(...args),
}))

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

function privateEvent(adapterId: string, messageId: string): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:private`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: "ch_private", kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

// 30s hook budget: the first cold open of the full schema (100+ Dexie
// versions) can exceed jest's default 5s under parallel suite load.
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  dispatchTriggerMock.mockReset()
  findMatchingWorkflowsMock.mockReset()
}, 30_000)

describe("ConnectorBus workflow trigger fan-out", () => {
  async function seedAutoAdapter(): Promise<string> {
    const row = await createAdapterInstance({
      type: "telegram",
      displayName: "Auto Bot",
      enabled: true,
      transportMode: "stub",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: AUTO_TRIGGER,
      defaultMode: "auto",
    })
    const bus = getBus()
    bus.registerAdapter(makeAdapter(row.id))
    return row.id
  }

  it("dispatches trigger events to every matching workflow", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf_a", nodeId: "n1", params: {} },
      { workflowId: "wf_b", nodeId: "n2", params: { adapterId } },
    ])

    const evt = privateEvent(adapterId, "msg_1")
    await getBus().dispatchInboundFull(evt)

    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.connector.inbound", {
      adapterId,
      conversationKey: evt.conversationKey,
      senderId: "u_alice",
      channelKind: "private",
      plainText: "hello",
      selfMentioned: false,
    })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
    const calls = dispatchTriggerMock.mock.calls.map(
      ([arg]) => arg as { workflowId: string; kind: string }
    )
    expect(calls.map((c) => c.workflowId).sort()).toEqual(["wf_a", "wf_b"])
    for (const c of calls) {
      expect(c.kind).toBe("trigger.connector.inbound")
    }
  })

  it("skips dispatch when the event is dropped (group without self-mention)", async () => {
    const adapterId = await seedAutoAdapter()
    const base = privateEvent(adapterId, "msg_group_1")
    const evt: NormalizedInboundEvent = {
      ...base,
      channel: { id: "ch_group", kind: "group" },
      mentions: { selfMentioned: false, users: [] },
    }
    await getBus().dispatchInboundFull(evt)
    expect(findMatchingWorkflowsMock).not.toHaveBeenCalled()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("audits + warns when findMatchingWorkflows throws (fan-out not silently disabled)", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockImplementation(() => {
      throw new Error("subscription index corrupted")
    })
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(
        getBus().dispatchInboundFull(privateEvent(adapterId, "msg_wf_match_err"))
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    const row = audit.find(
      (r) => r.kind === "adapter.error" && r.reason === "workflow_match_failed"
    )
    expect(row).toBeDefined()
    expect(row?.message).toContain("subscription index corrupted")
  })

  it("survives a workflow dispatch failure without breaking the bus", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf_oops", nodeId: "n", params: {} }])
    dispatchTriggerMock.mockRejectedValue(new Error("orchestrator down"))

    await expect(
      getBus().dispatchInboundFull(privateEvent(adapterId, "msg_2"))
    ).resolves.toBeUndefined()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
  })
})
