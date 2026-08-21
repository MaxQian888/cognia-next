/** @jest-environment node */

import {
  shouldRespondToMessage,
  gateInboundEvent,
  observeUnmentionedDeliveryProbe,
  consumeSiblingInterplayBudget,
  DEFAULT_AT_RESPONSE_STRATEGY,
  DEFAULT_BOT_INTERPLAY_BUDGET,
  __resetSiblingInterplayBudgetForTesting,
} from "./at-gate"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Module-level mocks for the I/O dependencies of gateInboundEvent.
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  updateAdapterInstance: jest.fn(async () => undefined),
}))
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn(async () => undefined),
}))
jest.mock("@/lib/connectors/sibling-bots", () => ({
  findSiblingBotSender: jest.fn(async () => null),
}))

import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"
import { findSiblingBotSender } from "@/lib/connectors/sibling-bots"

const mockGetAdapterInstance = getAdapterInstance as jest.MockedFunction<typeof getAdapterInstance>
const mockUpdateAdapterInstance = updateAdapterInstance as jest.MockedFunction<
  typeof updateAdapterInstance
>
const mockAppendAudit = appendAudit as jest.MockedFunction<typeof appendAudit>
const mockFindSibling = findSiblingBotSender as jest.MockedFunction<typeof findSiblingBotSender>

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    selfId: "bot-42",
    messageId: "msg-1",
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    conversationKey: "telegram:tg-1:chat-100",
    sender: {
      id: "user-1",
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "111",
      displayName: "Alice",
    },
    channel: {
      id: "chat-100",
      kind: "group",
      platformChannelId: "chat-100",
    },
    segments: [],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  }
}

function makeAdapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "tg-1",
    type: "telegram",
    displayName: "Test Bot",
    enabled: true,
    transportMode: "polling",
    settings: {},
    credentialsRef: { keyringService: "cognia", accounts: ["tg-1"] },
    trigger: { kind: "always" },
    defaultMode: "chat",
    ...overrides,
  } as AdapterInstanceRow
}

// ---------------------------------------------------------------------------
// DEFAULT_AT_RESPONSE_STRATEGY
// ---------------------------------------------------------------------------

describe("DEFAULT_AT_RESPONSE_STRATEGY", () => {
  it('is "mention_only"', () => {
    expect(DEFAULT_AT_RESPONSE_STRATEGY).toBe("mention_only")
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — kind guard
// ---------------------------------------------------------------------------

describe("shouldRespondToMessage — non-create kinds pass through", () => {
  const adapter = makeAdapter({ atResponseStrategy: "direct_only" })

  it("allows edit events without checking strategy", () => {
    const event = makeEvent({ kind: "edit", channel: { id: "chat-100", kind: "group" } })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("allows delete events without checking strategy", () => {
    const event = makeEvent({ kind: "delete", channel: { id: "chat-100", kind: "group" } })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("allows system events without checking strategy", () => {
    const event = makeEvent({ kind: "system", channel: { id: "chat-100", kind: "group" } })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — chatBlocklist
// ---------------------------------------------------------------------------

describe("shouldRespondToMessage — chatBlocklist", () => {
  it("denies when the chat id appears in chatBlocklist", () => {
    const event = makeEvent({ kind: "create" })
    const adapter = makeAdapter({ chatBlocklist: ["chat-100"] })
    const decision = shouldRespondToMessage(event, adapter)
    expect(decision).toEqual({ allowed: false, reason: "chat_blocklist" })
  })

  it("uses platformChannelId for the blocklist lookup, not the bus id", () => {
    const event = makeEvent({
      kind: "create",
      channel: { id: "bus-id", kind: "group", platformChannelId: "platform-99" },
    })
    const adapter = makeAdapter({ chatBlocklist: ["platform-99"] })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "chat_blocklist",
    })
  })

  it("falls back to the bus id when platformChannelId is absent", () => {
    const event = makeEvent({
      kind: "create",
      channel: { id: "bus-id", kind: "group" },
    })
    const adapter = makeAdapter({ chatBlocklist: ["bus-id"] })
    expect(shouldRespondToMessage(event, adapter).allowed).toBe(false)
  })

  it("allows a chat that is not in the blocklist", () => {
    const event = makeEvent({ kind: "create" })
    const adapter = makeAdapter({ chatBlocklist: ["other-chat"] })
    // strategy defaults to mention_only; group with no mention → at_mention_required.
    expect(shouldRespondToMessage(event, adapter).reason).not.toBe("chat_blocklist")
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — chatAllowlist
// ---------------------------------------------------------------------------

describe("shouldRespondToMessage — chatAllowlist", () => {
  it("denies when allowlist is non-empty and the chat id is absent", () => {
    const event = makeEvent({ kind: "create" })
    const adapter = makeAdapter({ chatAllowlist: ["other-chat"] })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "chat_allowlist",
    })
  })

  it("passes through (to strategy check) when the chat id is in the allowlist", () => {
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: true, users: [] },
    })
    const adapter = makeAdapter({
      chatAllowlist: ["chat-100"],
      atResponseStrategy: "mention_only",
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("treats an empty allowlist as 'allow all'", () => {
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: true, users: [] },
    })
    const adapter = makeAdapter({ chatAllowlist: [], atResponseStrategy: "mention_only" })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("treats an undefined allowlist as 'allow all'", () => {
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: true, users: [] },
    })
    const adapter = makeAdapter({ chatAllowlist: undefined, atResponseStrategy: "mention_only" })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — strategy: "always"
// ---------------------------------------------------------------------------

describe('shouldRespondToMessage — strategy "always"', () => {
  const adapter = makeAdapter({ atResponseStrategy: "always" })

  it("allows group messages with no mention", () => {
    const event = makeEvent({ kind: "create", mentions: { selfMentioned: false, users: [] } })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("allows DM messages", () => {
    const event = makeEvent({
      kind: "create",
      channel: { id: "dm-1", kind: "private" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — strategy: "mention_only" (default)
// ---------------------------------------------------------------------------

describe('shouldRespondToMessage — strategy "mention_only"', () => {
  const adapter = makeAdapter({ atResponseStrategy: "mention_only" })

  it("allows a group message when the bot is @-mentioned", () => {
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: true, users: ["bot-42"] },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("denies a group message when the bot is not @-mentioned", () => {
    const event = makeEvent({ kind: "create" })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "at_mention_required",
    })
  })

  it("allows an unmentioned group message that replies to one of OUR messages", () => {
    const event = makeEvent({
      kind: "create",
      replyTo: { messageId: "bot_out_7", snippet: "…", parentSenderId: "bot-42" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("still denies a reply to somebody else's message", () => {
    const event = makeEvent({
      kind: "create",
      replyTo: { messageId: "human_1", snippet: "…", parentSenderId: "user-9" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "at_mention_required",
    })
  })

  it("still denies a reply whose parent author is unknown", () => {
    const event = makeEvent({
      kind: "create",
      replyTo: { messageId: "unknown_1", snippet: "…" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "at_mention_required",
    })
  })

  it("allows DMs without a mention (DMs bypass the mention surface)", () => {
    const event = makeEvent({
      kind: "create",
      channel: { id: "dm-1", kind: "private" },
      mentions: { selfMentioned: false, users: [] },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("uses mention_only as default when atResponseStrategy is undefined", () => {
    const adapter = makeAdapter({ atResponseStrategy: undefined })
    const event = makeEvent({ kind: "create" })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "at_mention_required",
    })
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — strategy: "direct_only"
// ---------------------------------------------------------------------------

describe('shouldRespondToMessage — strategy "direct_only"', () => {
  const adapter = makeAdapter({ atResponseStrategy: "direct_only" })

  it("allows DMs", () => {
    const event = makeEvent({
      kind: "create",
      channel: { id: "dm-1", kind: "private" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })

  it("denies group messages even when @-mentioned", () => {
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: true, users: ["bot-42"] },
      channel: { id: "chat-100", kind: "group" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "at_direct_only",
    })
  })

  it("denies channel messages", () => {
    const event = makeEvent({
      kind: "create",
      channel: { id: "ch-1", kind: "channel" },
    })
    expect(shouldRespondToMessage(event, adapter)).toEqual({
      allowed: false,
      reason: "at_direct_only",
    })
  })
})

// ---------------------------------------------------------------------------
// shouldRespondToMessage — create kind (explicit)
// ---------------------------------------------------------------------------

describe("shouldRespondToMessage — explicit kind:create is gated normally", () => {
  it("applies strategy to an explicit create event", () => {
    const event = makeEvent({ kind: "create", mentions: { selfMentioned: false, users: [] } })
    const adapter = makeAdapter({ atResponseStrategy: "always" })
    expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
  })
})

// ---------------------------------------------------------------------------
// gateInboundEvent — integration with Dexie / audit
// ---------------------------------------------------------------------------

describe("gateInboundEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindSibling.mockResolvedValue(null)
    __resetSiblingInterplayBudgetForTesting()
  })

  it("returns true (fail-open) when the adapter row is not found in Dexie", async () => {
    mockGetAdapterInstance.mockResolvedValue(undefined)
    const event = makeEvent()
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it("returns true (fail-open) when getAdapterInstance rejects", async () => {
    mockGetAdapterInstance.mockRejectedValue(new Error("Dexie unavailable"))
    const event = makeEvent()
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it("returns true when the strategy permits the event", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "always" }))
    const event = makeEvent({ kind: "create" })
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it("defers mention admission to the durable bus", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "mention_only" }))
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: false, users: [] },
      channel: { id: "chat-100", kind: "group" },
    })
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it("does not infer Lark unmentioned readiness until an operator starts a probe", async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({
        type: "lark",
        inboundActivationPolicy: "mention_activates",
        deliveryReadiness: "mentions_only",
      })
    )
    const event = makeEvent({
      platform: "lark",
      channel: { id: "chat-100", kind: "group" },
      mentions: { selfMentioned: false, users: [] },
    })

    await expect(gateInboundEvent("tg-1", event)).resolves.toBe(true)
    expect(mockUpdateAdapterInstance).not.toHaveBeenCalled()
  })

  it("marks Lark all-message delivery verified only after observing an active probe", async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({
        type: "lark",
        inboundActivationPolicy: "mention_activates",
        deliveryReadiness: "mentions_only",
        settings: {
          unmentionedDeliveryProbe: {
            consoleConfirmed: true,
            startedAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
          },
        },
      })
    )
    const event = makeEvent({
      platform: "lark",
      channel: { id: "chat-100", kind: "group" },
      mentions: { selfMentioned: false, users: [] },
    })

    await expect(gateInboundEvent("tg-1", event)).resolves.toBe(true)
    await expect(
      observeUnmentionedDeliveryProbe(
        "tg-1",
        event,
        await mockGetAdapterInstance.mock.results[0].value
      )
    ).resolves.toBe(true)
    expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
      "tg-1",
      expect.objectContaining({ deliveryReadiness: "all_messages_verified" })
    )
  })

  it("does not use the transport gate for direct-only admission", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "direct_only" }))
    mockAppendAudit.mockRejectedValue(new Error("audit write failed"))
    const event = makeEvent({
      kind: "create",
      channel: { id: "chat-100", kind: "group" },
    })
    await expect(gateInboundEvent("tg-1", event)).resolves.toBe(true)
  })

  it("returns true for a non-create kind even when the strategy would block", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "direct_only" }))
    const event = makeEvent({ kind: "edit", channel: { id: "chat-100", kind: "group" } })
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// gateInboundEvent — sibling-bot anti-loop guard (W5 multi-bot same-group)
// ---------------------------------------------------------------------------

describe("gateInboundEvent — sibling-bot guard", () => {
  const siblingRow = { id: "tg-2" } as AdapterInstanceRow

  beforeEach(() => {
    jest.clearAllMocks()
    __resetSiblingInterplayBudgetForTesting()
    mockFindSibling.mockResolvedValue(siblingRow)
  })

  it("default policy ignores a sibling-bot message and audits it", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "always" }))
    const event = makeEvent({ kind: "create" })
    expect(await gateInboundEvent("tg-1", event)).toBe(false)
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "tg-1",
        kind: "inbound.sibling_bot_ignored",
        conversationKey: event.conversationKey,
        fields: { siblingAdapterId: "tg-2" },
      })
    )
  })

  it('explicit "ignore" policy behaves like the default', async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({ atResponseStrategy: "always", siblingBotPolicy: "ignore" })
    )
    expect(await gateInboundEvent("tg-1", makeEvent({ kind: "create" }))).toBe(false)
  })

  it('"respond" policy allows a sibling message under budget (normal gates still apply)', async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({ atResponseStrategy: "always", siblingBotPolicy: "respond" })
    )
    expect(await gateInboundEvent("tg-1", makeEvent({ kind: "create" }))).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it('"respond" defers mention admission to the bus after the sibling check', async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({ atResponseStrategy: "mention_only", siblingBotPolicy: "respond" })
    )
    const event = makeEvent({ kind: "create", mentions: { selfMentioned: false, users: [] } })
    expect(await gateInboundEvent("tg-1", event)).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it("exhausts the per-chat budget and audits the drop", async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({
        atResponseStrategy: "always",
        siblingBotPolicy: "respond",
        botInterplayBudget: 2,
      })
    )
    const event = makeEvent({ kind: "create" })
    expect(await gateInboundEvent("tg-1", event)).toBe(true)
    expect(await gateInboundEvent("tg-1", event)).toBe(true)
    expect(await gateInboundEvent("tg-1", event)).toBe(false)
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "inbound.sibling_bot_budget_exhausted",
        fields: { siblingAdapterId: "tg-2", budget: 2 },
      })
    )
  })

  it("tracks the budget per chat — another chat is unaffected", async () => {
    mockGetAdapterInstance.mockResolvedValue(
      makeAdapter({
        atResponseStrategy: "always",
        siblingBotPolicy: "respond",
        botInterplayBudget: 1,
      })
    )
    const chatA = makeEvent({ kind: "create" })
    const chatB = makeEvent({
      kind: "create",
      conversationKey: "telegram:tg-1:chat-200",
      channel: { id: "chat-200", kind: "group", platformChannelId: "chat-200" },
    })
    expect(await gateInboundEvent("tg-1", chatA)).toBe(true)
    expect(await gateInboundEvent("tg-1", chatA)).toBe(false)
    expect(await gateInboundEvent("tg-1", chatB)).toBe(true)
  })

  it("skips the sibling check for non-create kinds", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "always" }))
    const event = makeEvent({ kind: "edit" })
    expect(await gateInboundEvent("tg-1", event)).toBe(true)
    expect(mockFindSibling).not.toHaveBeenCalled()
  })

  it("fails open when the sibling lookup rejects", async () => {
    mockFindSibling.mockRejectedValue(new Error("dexie down"))
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "always" }))
    expect(await gateInboundEvent("tg-1", makeEvent({ kind: "create" }))).toBe(true)
  })

  it("non-sibling messages are unaffected", async () => {
    mockFindSibling.mockResolvedValue(null)
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "always" }))
    expect(await gateInboundEvent("tg-1", makeEvent({ kind: "create" }))).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// consumeSiblingInterplayBudget — sliding-hour window (clock injected)
// ---------------------------------------------------------------------------

describe("consumeSiblingInterplayBudget", () => {
  beforeEach(() => {
    __resetSiblingInterplayBudgetForTesting()
  })

  it("defaults to 4 responses per chat per hour", () => {
    expect(DEFAULT_BOT_INTERPLAY_BUDGET).toBe(4)
  })

  it("allows exactly `budget` spends inside one hour", () => {
    const t0 = 1_000_000_000
    expect(consumeSiblingInterplayBudget("a", "c", 2, t0)).toBe(true)
    expect(consumeSiblingInterplayBudget("a", "c", 2, t0 + 1_000)).toBe(true)
    expect(consumeSiblingInterplayBudget("a", "c", 2, t0 + 2_000)).toBe(false)
  })

  it("frees budget once spends age out of the trailing hour", () => {
    const t0 = 1_000_000_000
    const HOUR = 60 * 60 * 1000
    expect(consumeSiblingInterplayBudget("a", "c", 1, t0)).toBe(true)
    expect(consumeSiblingInterplayBudget("a", "c", 1, t0 + HOUR - 1)).toBe(false)
    expect(consumeSiblingInterplayBudget("a", "c", 1, t0 + HOUR + 1)).toBe(true)
  })

  it("scopes the ledger to (adapterId, chatId)", () => {
    const t0 = 1_000_000_000
    expect(consumeSiblingInterplayBudget("a", "c1", 1, t0)).toBe(true)
    expect(consumeSiblingInterplayBudget("a", "c2", 1, t0)).toBe(true)
    expect(consumeSiblingInterplayBudget("b", "c1", 1, t0)).toBe(true)
    expect(consumeSiblingInterplayBudget("a", "c1", 1, t0)).toBe(false)
  })
})
