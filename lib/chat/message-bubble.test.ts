import { userBubbleClass, assistantBubbleClass, messageCardClass } from "./message-bubble"
import type { MessageDisplayLayout } from "@/types/appearance"

const LAYOUTS: MessageDisplayLayout[] = ["hybrid", "bubbles", "cards"]

describe("userBubbleClass", () => {
  /**
   * The regression this module exists to prevent: `message-renderer` opted out
   * of the `cards` layout, so the user bubble fell through to the vendored
   * ai-elements default (`bg-secondary`, a different corner and padding) that
   * nobody chose. Every layout must now return a value.
   */
  it("styles the user bubble in every layout", () => {
    for (const layout of LAYOUTS) {
      expect(userBubbleClass(layout)).not.toBe("")
      expect(userBubbleClass(layout)).toContain("group-[.is-user]:bg-muted/70")
    }
  })

  it("keeps the same tone on both sides of the conversation", () => {
    // Different opacity, same hue — the two sides used to disagree for no
    // stated reason (bg-muted/70 vs bg-muted/45 vs bg-secondary).
    expect(userBubbleClass("hybrid")).toContain("bg-muted/")
    expect(assistantBubbleClass("bubbles")).toContain("bg-muted/")
  })

  it("tightens the bubble when it is nested inside a card", () => {
    expect(userBubbleClass("cards")).toContain("px-3")
    expect(userBubbleClass("hybrid")).toContain("px-4")
  })

  it("keeps the default layout's geometry byte-for-byte", () => {
    // Pins the pre-existing hybrid look: a 2px drift here is invisible in
    // review and obvious on screen.
    expect(userBubbleClass("hybrid")).toBe(
      "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md " +
        "group-[.is-user]:bg-muted/70 group-[.is-user]:px-4 group-[.is-user]:py-2.5"
    )
  })
})

describe("assistantBubbleClass", () => {
  it("only paints a bubble in the bubbles layout", () => {
    expect(assistantBubbleClass("bubbles")).not.toBe("")
    expect(assistantBubbleClass("hybrid")).toBe("")
    expect(assistantBubbleClass("cards")).toBe("")
  })
})

describe("messageCardClass", () => {
  it("only paints a card shell in the cards layout", () => {
    expect(messageCardClass("cards")).toContain("border")
    expect(messageCardClass("hybrid")).toBe("")
    expect(messageCardClass("bubbles")).toBe("")
  })
})

describe("style-pack reachability", () => {
  /**
   * `rounded-2xl` has no link to `--radius`, but globals.css rebases it under a
   * pack, so bubbles do follow Sharp. `rounded-lg`/`xl` would too. An arbitrary
   * value would not — pin that none is used.
   */
  it("uses no radius a style pack cannot reach", () => {
    for (const layout of LAYOUTS) {
      for (const cls of [
        userBubbleClass(layout),
        assistantBubbleClass(layout),
        messageCardClass(layout),
      ]) {
        expect(cls).not.toMatch(/rounded-\[/)
      }
    }
  })
})
