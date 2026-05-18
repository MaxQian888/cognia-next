/**
 * Tests for defaultConnectorCallbackHandler.
 *
 * We mock `runConnectorDigestTurn` so the handler test stays in-process
 * and doesn't require a real session / send pipeline.
 */

import "fake-indexeddb/auto"
import {
  appendA2UIEventHistory,
  defaultConnectorCallbackHandler,
  synthesizeCallbackPrompt,
} from "./connector-callback-handler"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"

jest.mock("@/lib/connectors/scheduled-outbound", () => ({
  __esModule: true,
  runConnectorDigestTurn: jest.fn(async () => ({ success: true, output: {} })),
}))

import { runConnectorDigestTurn } from "@/lib/connectors/scheduled-outbound"

const mockRunDigest = runConnectorDigestTurn as jest.MockedFunction<typeof runConnectorDigestTurn>

const baseEvent: ConnectorCallbackEvent = {
  platform: "slack",
  adapterId: "adp_sl",
  selfId: "U_BOT",
  triggerId: "trig_001",
  surfaceId: "sfc_1",
  componentId: "btn_yes",
  actionType: "button",
  value: "confirm",
  conversationKey: "slack:adp_sl:C_test",
  user: {
    id: "id-1",
    platform: "slack",
    adapterId: "adp_sl",
    remoteUserId: "U_user",
    displayName: "Alice",
  },
  timestamp: 1700000000000,
  raw: {},
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  mockRunDigest.mockClear()
})

describe("synthesizeCallbackPrompt", () => {
  it("includes platform / surface / component / action / value", () => {
    expect(synthesizeCallbackPrompt(baseEvent)).toBe(
      "[A2UI slack callback] surface=sfc_1 component=btn_yes action=button value=confirm"
    )
  })

  it("appends form payload JSON when present", () => {
    const out = synthesizeCallbackPrompt({
      ...baseEvent,
      actionType: "submit",
      value: "",
      payload: { name: "Alice", role: "admin" },
    })
    expect(out).toContain("action=submit")
    expect(out).toContain('payload={"name":"Alice","role":"admin"}')
  })

  it("skips empty value and missing component", () => {
    const out = synthesizeCallbackPrompt({
      ...baseEvent,
      componentId: undefined,
      value: "",
      actionType: "dismiss",
    })
    expect(out).toBe("[A2UI slack callback] surface=sfc_1 action=dismiss")
  })
})

describe("appendA2UIEventHistory", () => {
  it("writes a userAction row keyed by callback triggerId", async () => {
    await appendA2UIEventHistory(baseEvent)
    const rows = await getDb().a2uiEventHistory.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].surfaceId).toBe("sfc_1")
    expect(rows[0].type).toBe("userAction")
    expect((rows[0].payload as Record<string, unknown>).source).toBe("connector")
    expect((rows[0].payload as Record<string, unknown>).platform).toBe("slack")
    expect((rows[0].payload as Record<string, unknown>).actionType).toBe("button")
  })

  it("caps the table at 1000 rows newest-first", async () => {
    // Pre-seed 1001 rows so the next insert triggers the cap.
    const db = getDb()
    const seed = Array.from({ length: 1001 }, (_, i) => ({
      id: `e_${i}`,
      surfaceId: "sfc_seed",
      type: "userAction" as const,
      payload: {},
      timestamp: 1000 + i,
    }))
    await db.a2uiEventHistory.bulkPut(seed)
    await appendA2UIEventHistory(baseEvent)
    expect(await db.a2uiEventHistory.count()).toBe(1000)
    // The just-inserted callback row survives (newest); the oldest seed is gone.
    expect(await db.a2uiEventHistory.get("cb:trig_001")).toBeDefined()
    expect(await db.a2uiEventHistory.get("e_0")).toBeUndefined()
  })
})

describe("defaultConnectorCallbackHandler", () => {
  it("appends to a2uiEventHistory and triggers a digest turn with synthesized prompt", async () => {
    await defaultConnectorCallbackHandler(baseEvent, "slack:adp_sl:C_test")
    expect(await getDb().a2uiEventHistory.count()).toBe(1)
    expect(mockRunDigest).toHaveBeenCalledWith({
      adapterId: "adp_sl",
      conversationKey: "slack:adp_sl:C_test",
      characterId: undefined,
      prompt: expect.stringContaining("[A2UI slack callback]"),
      sourceTaskId: "cb:trig_001",
    })
  })

  it("uses event.conversationKey when boundConversationKey is null", async () => {
    await defaultConnectorCallbackHandler(baseEvent, null)
    expect(mockRunDigest).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "slack:adp_sl:C_test" })
    )
  })

  it("skips the digest turn when no conversationKey is available", async () => {
    await defaultConnectorCallbackHandler({ ...baseEvent, conversationKey: undefined }, null)
    expect(mockRunDigest).not.toHaveBeenCalled()
    // History row is still written so the surface debugger sees the click.
    expect(await getDb().a2uiEventHistory.count()).toBe(1)
  })
})
