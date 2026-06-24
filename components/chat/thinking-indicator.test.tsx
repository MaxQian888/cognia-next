import { render } from "@testing-library/react"

// Local next-intl mock: deterministic label + a controllable `tips` raw value
// (independent of the committed en.json content) so we can exercise the
// non-array / throwing fallbacks in `readTips`.
const rawState: { value: unknown; throws: boolean } = {
  value: ["Tip A", "Tip B", "Tip C"],
  throws: false,
}
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const dict: Record<string, unknown> = { thinking: "Thinking now" }
    const t = (key: string) => (typeof dict[key] === "string" ? (dict[key] as string) : key)
    ;(t as unknown as { raw: (k: string) => unknown }).raw = () => {
      if (rawState.throws) throw new Error("missing key")
      return rawState.value
    }
    return t
  },
}))

// Drive the phase machine directly — no real timers in the component test.
const phase = { showSkeleton: false, showTips: false, tipIndex: 0 }
jest.mock("@/hooks/chat/use-thinking-phase", () => ({
  useThinkingPhase: () => phase,
}))

// Control reduced-motion for the indicator's own animate-pulse / dots classes.
const flowMotion = { reduce: false, speed: 1 }
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
    flowMotion.reduce = false
    flowMotion.speed = 1
    rawState.value = ["Tip A", "Tip B", "Tip C"]
    rawState.throws = false
  })

  it("renders the shimmer label and bouncing dots in phase 1", () => {
    const { getByTestId, queryByTestId } = render(<ChatThinkingIndicator />)
    const root = getByTestId("chat-thinking-indicator")
    expect(root.textContent).toContain("Thinking now")
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
    rawState.value = undefined
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
    rawState.value = ["Real tip", 42, null, "Another tip"]
    phase.showTips = true
    phase.tipIndex = 1
    const { getByRole } = render(<ChatThinkingIndicator />)
    // Only the two strings survive → index 1 is "Another tip".
    expect(getByRole("note").textContent).toContain("Another tip")
  })
})
