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
const phase = { showSkeleton: false, showTips: false, tipIndex: 0, verbIndex: 0 }
jest.mock("@/hooks/chat/use-thinking-phase", () => ({
  useThinkingPhase: () => phase,
}))

// Control reduced-motion for the indicator's own animate-pulse / dots classes.
const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => {
  const actual = jest.requireActual("@/components/chat/motion/motion-reveal")
  return { ...actual, useFlowMotion: () => flowMotion }
})

import { ChatThinkingIndicator } from "./thinking-indicator"

describe("ChatThinkingIndicator", () => {
  beforeEach(() => {
    phase.showSkeleton = false
    phase.showTips = false
    phase.tipIndex = 0
    phase.verbIndex = 0
    flowMotion.reduce = false
    flowMotion.durationScale = 1
    rawState.tips = ["Tip A", "Tip B", "Tip C"]
    rawState.verbs = []
    rawState.throws = false
  })

  it("renders the shimmer label and bouncing dots in phase 1", () => {
    const { getByTestId, queryByTestId } = render(<ChatThinkingIndicator />)
    const root = getByTestId("chat-thinking-indicator")
    expect(root.textContent).toContain("Thinking now")
    expect(root.querySelector(".shimmer")).toBeInTheDocument()
    // No skeleton or tip yet.
    expect(queryByTestId("thinking-skeleton")).toBeNull()
  })

  it("reveals the skeleton placeholder lines once showSkeleton is set", () => {
    phase.showSkeleton = true
    const { getByTestId } = render(<ChatThinkingIndicator />)
    expect(getByTestId("thinking-skeleton")).toBeInTheDocument()
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

  it("calls onPhaseChange when phases change (re-pin scroll)", () => {
    const onPhaseChange = jest.fn()
    render(<ChatThinkingIndicator onPhaseChange={onPhaseChange} />)
    // Fires at least once on mount so the list re-pins as the row appears.
    expect(onPhaseChange).toHaveBeenCalled()
  })

  it("drops the pulse animation under reduced motion", () => {
    flowMotion.reduce = true
    const { getByTestId } = render(<ChatThinkingIndicator />)
    const root = getByTestId("chat-thinking-indicator")
    expect(root.querySelector(".animate-pulse")).toBeNull()
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

  // Compact mode: the assistant already has visible content on screen, so the
  // skeleton would read as a phantom second reply. Label + tips still run.
  it("drops the skeleton in compact mode even once showSkeleton is set", () => {
    phase.showSkeleton = true
    const { queryByTestId, getByTestId } = render(<ChatThinkingIndicator compact />)
    expect(queryByTestId("thinking-skeleton")).toBeNull()
    // Still alive: the label is what signals the turn is running.
    expect(getByTestId("chat-thinking-indicator").textContent).toContain("Thinking now")
  })

  it("still renders tips in compact mode (a tool-heavy stretch is a long wait)", () => {
    phase.showTips = true
    phase.tipIndex = 0
    const { getByRole } = render(<ChatThinkingIndicator compact />)
    expect(getByRole("note").textContent).toContain("Tip A")
  })
})
