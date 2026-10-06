import { render } from "@testing-library/react"

// Local next-intl mock: deterministic label + controllable `tips` / `verbs` raw
// values (independent of the committed en.json content) so we can exercise the
// non-array / throwing fallbacks in `readStringList`. Key-aware, so reading one
// list can't accidentally return the other's contents.
const rawState: { tips: unknown; verbs: unknown; throws: boolean } = {
  tips: ["Tip A", "Tip B", "Tip C"],
  verbs: [],
  throws: false,
}
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const dict: Record<string, unknown> = { thinking: "Thinking now" }
    const t = (key: string) => (typeof dict[key] === "string" ? (dict[key] as string) : key)
    ;(t as unknown as { raw: (k: string) => unknown }).raw = (key: string) => {
      if (rawState.throws) throw new Error("missing key")
      return key === "verbs" ? rawState.verbs : rawState.tips
    }
    return t
  },
}))

// Drive the phase machine directly — no real timers in the component test.
const phase = { showTips: false, tipIndex: 0, verbIndex: 0 }
jest.mock("@/hooks/chat/use-thinking-phase", () => ({
  useThinkingPhase: () => phase,
}))

// Control reduced motion: the in-app setting reaches the indicator through here.
const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => {
  const actual = jest.requireActual("@/components/chat/motion/motion-reveal")
  return { ...actual, useFlowMotion: () => flowMotion }
})

import { ChatThinkingIndicator } from "./thinking-indicator"

describe("ChatThinkingIndicator", () => {
  beforeEach(() => {
    phase.showTips = false
    phase.tipIndex = 0
    phase.verbIndex = 0
    flowMotion.reduce = false
    flowMotion.durationScale = 1
    rawState.tips = ["Tip A", "Tip B", "Tip C"]
    rawState.verbs = []
    rawState.throws = false
  })

  it("shows one shimmering status word and nothing else at first", () => {
    const { getByTestId, queryByRole } = render(<ChatThinkingIndicator />)
    const root = getByTestId("chat-thinking-indicator")
    expect(root.textContent).toContain("Thinking now")
    expect(root.querySelector(".shimmer")).toBeInTheDocument()
    // One moving thing: no bouncing dots, no pulsing avatar, no skeleton bars.
    expect(root.querySelector(".animate-bounce")).toBeNull()
    expect(root.querySelector(".animate-pulse")).toBeNull()
    expect(root.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(queryByRole("note")).toBeNull()
  })

  it("renders the rotating tip once showTips is set", () => {
    phase.showTips = true
    phase.tipIndex = 1
    const { getByRole } = render(<ChatThinkingIndicator />)
    expect(getByRole("note").textContent).toContain("Tip B")
  })

  it("tints the avatar with the direct character's glyph when provided", () => {
    const { getByTestId } = render(
      <ChatThinkingIndicator directCharacter={{ name: "Ada", avatarEmoji: "🤖" } as never} />
    )
    expect(getByTestId("chat-thinking-indicator").textContent).toContain("🤖")
  })

  it("swaps words inside one grid cell, so a rotation never changes the row's height", () => {
    // ADR-0138 — this row runs for minutes. The outgoing and incoming words
    // overlap in a single cell while they cross-fade; nothing sits to their
    // right, so a width change moves nothing either.
    rawState.verbs = ["Thinking…", "Pondering…"]
    const { getByTestId } = render(<ChatThinkingIndicator />)
    const shimmer = getByTestId("chat-thinking-indicator").querySelector(".shimmer")!
    expect(shimmer.parentElement).toHaveClass("col-start-1", "row-start-1")
    expect(shimmer.parentElement?.parentElement).toHaveClass("grid")
  })

  it("shows the word as static text under reduced motion, in-app setting included", () => {
    // `Shimmer` alone follows only the OS preference; the in-app setting
    // arrives through useFlowMotion and must stop the sweep too.
    flowMotion.reduce = true
    const { getByTestId } = render(<ChatThinkingIndicator />)
    const root = getByTestId("chat-thinking-indicator")
    expect(root.querySelector(".shimmer")).toBeNull()
    expect(root.textContent).toContain("Thinking now")
  })

  it("renders no tip when the tips key is not an array", () => {
    rawState.tips = undefined
    phase.showTips = true
    const { queryByRole } = render(<ChatThinkingIndicator />)
    expect(queryByRole("note")).toBeNull()
  })

  it("tolerates the tips key throwing (missing translation)", () => {
    rawState.throws = true
    phase.showTips = true
    const { queryByRole } = render(<ChatThinkingIndicator />)
    expect(queryByRole("note")).toBeNull()
  })

  it("filters out non-string entries in the tips array", () => {
    rawState.tips = ["Real tip", 42, null, "Another tip"]
    phase.showTips = true
    phase.tipIndex = 1
    const { getByRole } = render(<ChatThinkingIndicator />)
    // Only the two strings survive → index 1 is "Another tip".
    expect(getByRole("note").textContent).toContain("Another tip")
  })

  it("labels with the rotating verb at the current index when verbs exist", () => {
    rawState.verbs = ["Thinking…", "Pondering…", "Brewing…"]
    phase.verbIndex = 2
    const { getByTestId } = render(<ChatThinkingIndicator />)
    expect(getByTestId("chat-thinking-indicator").textContent).toContain("Brewing…")
  })

  it("wraps a verb index past the end of the list", () => {
    rawState.verbs = ["Thinking…", "Pondering…"]
    phase.verbIndex = 3
    const { getByTestId } = render(<ChatThinkingIndicator />)
    expect(getByTestId("chat-thinking-indicator").textContent).toContain("Pondering…")
  })

  it("falls back to the `thinking` key when the verbs list is missing", () => {
    rawState.verbs = undefined
    const { getByTestId } = render(<ChatThinkingIndicator />)
    expect(getByTestId("chat-thinking-indicator").textContent).toContain("Thinking now")
  })

  it("leads with the avatar while nothing of the reply is on screen", () => {
    const { getByTestId } = render(<ChatThinkingIndicator />)
    expect(getByTestId("thinking-avatar")).toBeInTheDocument()
  })

  // Compact mode: the reply above already shows who is answering, so the row
  // drops its avatar and lines up with the reply's text. The label still runs.
  it("drops the avatar in compact mode and aligns the label with the reply", () => {
    const { queryByTestId, getByTestId } = render(<ChatThinkingIndicator compact />)
    expect(queryByTestId("thinking-avatar")).toBeNull()
    const root = getByTestId("chat-thinking-indicator")
    expect(root).toHaveAttribute("data-compact", "true")
    expect(root.firstElementChild).toHaveClass("pl-8")
    expect(root.textContent).toContain("Thinking now")
  })

  it("still renders tips in compact mode (a tool-heavy stretch is a long wait)", () => {
    phase.showTips = true
    phase.tipIndex = 0
    const { getByRole } = render(<ChatThinkingIndicator compact />)
    expect(getByRole("note").textContent).toContain("Tip A")
  })
})
