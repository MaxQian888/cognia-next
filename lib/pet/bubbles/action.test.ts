import { bubbleActionForKind, decodePetBubbleAction } from "./action"

describe("decodePetBubbleAction", () => {
  it("accepts an open-console action at a real tab", () => {
    expect(decodePetBubbleAction({ kind: "open-console", tab: "insights" })).toEqual({
      kind: "open-console",
      tab: "insights",
    })
  })

  it("rebuilds the object, so extra keys never ride along", () => {
    const decoded = decodePetBubbleAction({
      kind: "open-console",
      tab: "shop",
      href: "javascript:alert(1)",
    })
    expect(decoded).toEqual({ kind: "open-console", tab: "shop" })
    expect(decoded).not.toHaveProperty("href")
  })

  it.each([
    ["an unknown kind", { kind: "navigate", tab: "insights" }],
    ["an unknown tab", { kind: "open-console", tab: "settings" }],
    ["a missing tab", { kind: "open-console" }],
    ["a string", "open-console"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
  ])("rejects %s", (_label, value) => {
    expect(decodePetBubbleAction(value)).toBeNull()
  })
})

describe("bubbleActionForKind", () => {
  it("points a radar report at the console's Insights tab", () => {
    expect(bubbleActionForKind("radarReport")).toEqual({ kind: "open-console", tab: "insights" })
  })

  it("offers nothing for ordinary kinds", () => {
    expect(bubbleActionForKind("fed")).toBeUndefined()
    expect(bubbleActionForKind("success")).toBeUndefined()
  })

  it("hands out a fresh object, so a caller cannot mutate the table", () => {
    const a = bubbleActionForKind("radarReport")!
    ;(a as { tab: string }).tab = "shop"
    expect(bubbleActionForKind("radarReport")).toEqual({ kind: "open-console", tab: "insights" })
  })
})
