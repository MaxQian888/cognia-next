import {
  decodePetBridgeMessage,
  encodePetBridgeMessage,
  PET_BRIDGE_CHANNEL,
  type PetBridgeMessage,
} from "./cross-window-protocol"

describe("cross-window-protocol", () => {
  const valid: PetBridgeMessage[] = [
    { v: 1, t: "visual-state", state: "thinking" },
    { v: 1, t: "one-shot", shot: "levelUp" },
    { v: 1, t: "bubble", bubble: { text: "hi" } },
    { v: 1, t: "bubble", bubble: { text: "hi", origin: "llm" } },
    { v: 1, t: "bubble", bubble: null },
    { v: 1, t: "interaction", kind: "fed" },
    { v: 1, t: "interaction", kind: "talked", text: "hello pet" },
    { v: 1, t: "request-state" },
  ]

  it("exposes the shared channel name", () => {
    expect(PET_BRIDGE_CHANNEL).toBe("cognia-pet-bridge")
  })

  it("round-trips every valid message (encode → decode)", () => {
    for (const msg of valid) {
      expect(decodePetBridgeMessage(encodePetBridgeMessage(msg))).toEqual(msg)
    }
  })

  it("keeps a valid bubble origin and strips an unknown one", () => {
    expect(
      decodePetBridgeMessage({ v: 1, t: "bubble", bubble: { text: "hello", origin: "llm" } })
    ).toEqual({ v: 1, t: "bubble", bubble: { text: "hello", origin: "llm" } })
    expect(
      decodePetBridgeMessage({ v: 1, t: "bubble", bubble: { text: "hello", origin: "weird" } })
    ).toEqual({ v: 1, t: "bubble", bubble: { text: "hello" } })
  })

  it("caps interaction text at 500 chars and drops empty/non-string text", () => {
    const long = "x".repeat(600)
    expect(decodePetBridgeMessage({ v: 1, t: "interaction", kind: "talked", text: long })).toEqual({
      v: 1,
      t: "interaction",
      kind: "talked",
      text: "x".repeat(500),
    })
    expect(decodePetBridgeMessage({ v: 1, t: "interaction", kind: "talked", text: "   " })).toEqual(
      { v: 1, t: "interaction", kind: "talked" }
    )
    expect(decodePetBridgeMessage({ v: 1, t: "interaction", kind: "talked", text: 7 })).toEqual({
      v: 1,
      t: "interaction",
      kind: "talked",
    })
  })

  describe("rejection", () => {
    const rejected: [string, unknown][] = [
      ["null", null],
      ["non-object", 42],
      ["string", "visual-state"],
      ["wrong version", { v: 2, t: "request-state" }],
      ["missing version", { t: "request-state" }],
      ["unknown type", { v: 1, t: "explode" }],
      ["visual-state with bad state", { v: 1, t: "visual-state", state: "nope" }],
      ["visual-state with non-string state", { v: 1, t: "visual-state", state: 3 }],
      ["one-shot with bad shot", { v: 1, t: "one-shot", shot: "spin" }],
      ["bubble with non-object payload", { v: 1, t: "bubble", bubble: "hi" }],
      ["bubble with missing text", { v: 1, t: "bubble", bubble: {} }],
      ["bubble with non-string text", { v: 1, t: "bubble", bubble: { text: 5 } }],
      ["interaction with bad kind", { v: 1, t: "interaction", kind: "sneezed" }],
      ["interaction with non-string kind", { v: 1, t: "interaction", kind: 1 }],
    ]

    it.each(rejected)("rejects %s → null", (_label, raw) => {
      expect(decodePetBridgeMessage(raw)).toBeNull()
    })
  })

  it("encode is identity", () => {
    const msg: PetBridgeMessage = { v: 1, t: "request-state" }
    expect(encodePetBridgeMessage(msg)).toBe(msg)
  })
})
