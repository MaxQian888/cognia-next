/** @jest-environment node */

import { shouldRespondToMessage, gateInboundEvent, DEFAULT_AT_RESPONSE_STRATEGY } from "./at-gate"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Module-level mocks for the two I/O dependencies of gateInboundEvent.
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
}))
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn(async () => undefined),
}))

import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"

const mockGetAdapterInstance = getAdapterInstance as jest.MockedFunction<typeof getAdapterInstance>
const mockAppendAudit = appendAudit as jest.MockedFunction<typeof appendAudit>

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

  it("returns false and calls appendAudit when the event is blocked", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "mention_only" }))
    const event = makeEvent({
      kind: "create",
      mentions: { selfMentioned: false, users: [] },
      channel: { id: "chat-100", kind: "group" },
    })
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(false)
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "tg-1",
        kind: "inbound.policy_blocked",
        reason: "at_mention_required",
        conversationKey: event.conversationKey,
      })
    )
  })

  it("does not throw when appendAudit rejects (audit failure is fire-and-forget)", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "direct_only" }))
    mockAppendAudit.mockRejectedValue(new Error("audit write failed"))
    const event = makeEvent({
      kind: "create",
      channel: { id: "chat-100", kind: "group" },
    })
    await expect(gateInboundEvent("tg-1", event)).resolves.toBe(false)
  })

  it("returns true for a non-create kind even when the strategy would block", async () => {
    mockGetAdapterInstance.mockResolvedValue(makeAdapter({ atResponseStrategy: "direct_only" }))
    const event = makeEvent({ kind: "edit", channel: { id: "chat-100", kind: "group" } })
    const result = await gateInboundEvent("tg-1", event)
    expect(result).toBe(true)
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })
})
