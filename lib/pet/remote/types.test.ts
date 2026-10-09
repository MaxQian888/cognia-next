import {
  encodeChatPageToken,
  isPetRemoteSnapshot,
  parseCallerDeviceId,
  parseIdempotencyKey,
  parsePetActRequest,
  parsePetApplyRequest,
  parsePetChatListRequest,
  parsePetChatSendRequest,
  parsePetPurchaseRequest,
  parsePetRenameRequest,
  refused,
  toRemoteRefusal,
  PET_CHAT_PAGE_SIZE_DEFAULT,
} from "./types"

describe("toRemoteRefusal", () => {
  it("drops the rate limiter's cause, which neither serializes nor means anything remotely", () => {
    expect(toRemoteRefusal({ code: "rate-limited", cause: new Error("bucket") })).toEqual({
      code: "rate-limited",
    })
  })

  it("flattens every gate refusal into the wire shape", () => {
    expect(toRemoteRefusal({ code: "unavailable", reason: "disabled" })).toEqual({
      code: "unavailable",
      reason: "disabled",
    })
    expect(toRemoteRefusal({ code: "cooling-down", kind: "fed", retryAfterMs: 900 })).toEqual({
      code: "cooling-down",
      kind: "fed",
      retryAfterMs: 900,
    })
    expect(
      toRemoteRefusal({
        code: "item-kind-mismatch",
        itemId: "ball",
        kind: "fed",
        itemKind: "played",
      })
    ).toEqual({ code: "item-kind-mismatch", itemId: "ball", kind: "fed", itemKind: "played" })
    expect(toRemoteRefusal({ code: "item-not-owned", itemId: "apple" })).toEqual({
      code: "item-not-owned",
      itemId: "apple",
    })
    expect(toRemoteRefusal({ code: "kind-not-allowed", kind: "x" })).toEqual({
      code: "kind-not-allowed",
      kind: "x",
    })
    expect(toRemoteRefusal({ code: "not-hatched" })).toEqual({ code: "not-hatched" })
    expect(refused({ code: "headless-host" })).toEqual({
      ok: false,
      refusal: { code: "headless-host" },
    })
  })
})

describe("request parsers", () => {
  it("requires the injected caller and a bounded idempotency key", () => {
    expect(parseCallerDeviceId({ callerDeviceId: "phone" })).toBe("phone")
    expect(() => parseCallerDeviceId({})).toThrow("callerDeviceId is required")
    expect(parseIdempotencyKey({ idempotencyKey: "k" })).toBe("k")
    expect(() => parseIdempotencyKey({ idempotencyKey: "x".repeat(129) })).toThrow("128")
  })

  it("accepts only the care kinds the gate accepts", () => {
    expect(parsePetActRequest({ action: "fed", itemId: "apple" })).toEqual({
      action: "fed",
      itemId: "apple",
    })
    expect(parsePetActRequest({ action: "talked" })).toEqual({ action: "talked" })
    expect(() => parsePetActRequest({ action: "levelUp" })).toThrow("action must be one of")
    expect(() => parsePetActRequest({ action: "fed", itemId: "" })).toThrow("itemId")
  })

  it("bounds purchases", () => {
    expect(parsePetPurchaseRequest({ itemId: "apple", qty: 3 })).toEqual({
      itemId: "apple",
      qty: 3,
    })
    for (const qty of [0, 100, 1.5, "2"]) {
      expect(() => parsePetPurchaseRequest({ itemId: "apple", qty })).toThrow("qty")
    }
  })

  it("parses decor, rename and chat requests", () => {
    expect(parsePetApplyRequest({ itemId: "hat-crown" })).toEqual({ itemId: "hat-crown" })
    expect(parsePetRenameRequest({ name: "Mochi" })).toEqual({ name: "Mochi" })
    expect(() => parsePetRenameRequest({ name: "x".repeat(65) })).toThrow("64")
    expect(parsePetChatSendRequest({ text: "hi", locale: "zh-CN" })).toEqual({
      text: "hi",
      locale: "zh-CN",
    })
    expect(() => parsePetChatSendRequest({ text: "hi", locale: "fr" })).toThrow("locale")
    expect(() => parsePetChatSendRequest({ text: "x".repeat(501), locale: "en" })).toThrow("500")
  })

  it("round-trips its own page token and refuses anything else", () => {
    expect(parsePetChatListRequest({})).toEqual({ pageSize: PET_CHAT_PAGE_SIZE_DEFAULT, offset: 0 })
    expect(parsePetChatListRequest({ pageSize: 10, pageToken: encodeChatPageToken(20) })).toEqual({
      pageSize: 10,
      offset: 20,
    })
    expect(() => parsePetChatListRequest({ pageToken: "20" })).toThrow("pageToken")
    expect(() => parsePetChatListRequest({ pageToken: "pc:-1" })).toThrow("pageToken")
    expect(() => parsePetChatListRequest({ pageSize: 201 })).toThrow("pageSize")
  })
})

describe("response guards", () => {
  const summary = {
    hatched: true,
    name: "Mochi",
    level: 2,
    stage: "baby",
    xp: 40,
    mood: "happy",
    needs: { energy: 80, mood: 70, bond: 60 },
    condition: "well",
    coins: 12,
    streak: { days: 3, lastDay: "2026-10-09", multiplier: 1.25 },
    cooldowns: { fed: 0 },
  }

  it("accepts a full snapshot and a pet-less one", () => {
    expect(
      isPetRemoteSnapshot({
        availability: { available: true },
        summary,
        presentation: null,
        hostTime: 5,
      })
    ).toBe(true)
    expect(
      isPetRemoteSnapshot({
        availability: { available: false, reason: "headless-host" },
        summary: null,
        presentation: null,
        hostTime: 5,
      })
    ).toBe(true)
  })

  it("rejects a malformed answer instead of painting half of it", () => {
    expect(isPetRemoteSnapshot(null)).toBe(false)
    expect(
      isPetRemoteSnapshot({ availability: { available: false }, summary: null, hostTime: 1 })
    ).toBe(false)
    expect(
      isPetRemoteSnapshot({
        availability: { available: true },
        summary: { ...summary, coins: -1 },
        presentation: null,
        hostTime: 1,
      })
    ).toBe(false)
  })
})
