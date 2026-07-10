/** @jest-environment node */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstancesByType: jest.fn(),
}))

import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import {
  findSiblingBotSender,
  __resetSiblingBotCacheForTesting,
  SIBLING_LOOKUP_TTL_MS,
} from "./sibling-bots"

const mockList = listAdapterInstancesByType as jest.MockedFunction<
  typeof listAdapterInstancesByType
>

function makeRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "lark-b",
    type: "lark",
    displayName: "Bot B",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: { keyringService: "cognia", accounts: [] },
    trigger: { kind: "always" },
    defaultMode: "chat",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as AdapterInstanceRow
}

function makeEvent(overrides: Partial<Parameters<typeof findSiblingBotSender>[0]> = {}) {
  return {
    platform: "lark" as const,
    adapterId: "lark-a",
    sender: {
      id: "ou_bot_b",
      platform: "lark" as const,
      adapterId: "lark-a",
      remoteUserId: "ou_bot_b",
    },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetSiblingBotCacheForTesting()
})

describe("findSiblingBotSender", () => {
  it("matches a sibling by lastWhoamiResult.openId", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    const row = await findSiblingBotSender(makeEvent())
    expect(row?.id).toBe("lark-b")
  })

  it("matches a sibling by settings.selfBotOpenId", async () => {
    mockList.mockResolvedValue([makeRow({ id: "lark-b", settings: { selfBotOpenId: "ou_bot_b" } })])
    const row = await findSiblingBotSender(makeEvent())
    expect(row?.id).toBe("lark-b")
  })

  it("matches on sender.id when remoteUserId differs", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    const row = await findSiblingBotSender(
      makeEvent({
        sender: {
          id: "ou_bot_b",
          platform: "lark",
          adapterId: "lark-a",
          remoteUserId: "union_something_else",
        },
      })
    )
    expect(row?.id).toBe("lark-b")
  })

  it("never matches the receiving adapter's own row", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-a",
        lastWhoamiResult: { botName: "A", appId: "cli_a", openId: "ou_bot_b" },
      }),
    ])
    expect(await findSiblingBotSender(makeEvent())).toBeNull()
  })

  it("never matches a disabled sibling row", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        enabled: false,
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    expect(await findSiblingBotSender(makeEvent())).toBeNull()
  })

  it("returns null when no row carries a matching self id", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_other" },
      }),
    ])
    expect(await findSiblingBotSender(makeEvent())).toBeNull()
  })

  it("queries only the event's platform (other-platform rows never seen)", async () => {
    mockList.mockResolvedValue([])
    await findSiblingBotSender(makeEvent())
    expect(mockList).toHaveBeenCalledWith("lark")
  })

  it("fails open (null) when the Dexie read rejects", async () => {
    mockList.mockRejectedValue(new Error("dexie down"))
    expect(await findSiblingBotSender(makeEvent())).toBeNull()
  })

  it("serves the second lookup for the same sender from the TTL cache", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    await findSiblingBotSender(makeEvent())
    const again = await findSiblingBotSender(makeEvent())
    expect(again?.id).toBe("lark-b")
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it("re-queries after the TTL elapses", async () => {
    const nowSpy = jest.spyOn(Date, "now")
    nowSpy.mockReturnValue(1_000_000)
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    await findSiblingBotSender(makeEvent())
    nowSpy.mockReturnValue(1_000_000 + SIBLING_LOOKUP_TTL_MS + 1)
    await findSiblingBotSender(makeEvent())
    expect(mockList).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })

  it("keys the cache by receiving adapter (sibling for A, self for B)", async () => {
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    const forA = await findSiblingBotSender(makeEvent({ adapterId: "lark-a" }))
    expect(forA?.id).toBe("lark-b")
    // Same sender observed by lark-b itself — its own row must not match.
    const forB = await findSiblingBotSender(makeEvent({ adapterId: "lark-b" }))
    expect(forB).toBeNull()
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failed lookup", async () => {
    mockList.mockRejectedValueOnce(new Error("transient"))
    expect(await findSiblingBotSender(makeEvent())).toBeNull()
    mockList.mockResolvedValue([
      makeRow({
        id: "lark-b",
        lastWhoamiResult: { botName: "B", appId: "cli_b", openId: "ou_bot_b" },
      }),
    ])
    expect((await findSiblingBotSender(makeEvent()))?.id).toBe("lark-b")
  })
})
