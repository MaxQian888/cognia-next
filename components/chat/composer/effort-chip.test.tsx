/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { EffortChip } from "./effort-chip"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
}))

let mockSettings: Partial<AppSettings> | null = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: Partial<AppSettings> | null }) => T) =>
    selector({ settings: mockSettings }),
}))

let mockRuntime: "claude-sdk" | "external" = "claude-sdk"
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () =>
    mockRuntime === "external" ? { kind: "external", agentId: "a1" } : { kind: "builtin" },
}))

jest.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => 300 }))

const useIsMobileMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => useIsMobileMock() }))

// Radix Popover needs these pointer primitives in jsdom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

const session: ChatSession = {
  id: "ses_1",
  title: "t",
  kind: "direct",
  model: "claude-opus-5",
  providerOverride: "anthropic",
  effort: "xhigh",
  thinkingLevel: "xhigh",
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  mockSettings = null
  mockRuntime = "claude-sdk"
  useIsMobileMock.mockReset().mockReturnValue(false)
})

describe("self-gating", () => {
  it("renders nothing without a session", () => {
    const { container } = render(<EffortChip session={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing on a model with no depth ladder", () => {
    const { container } = render(
      <EffortChip session={{ ...session, model: "claude-haiku-4-5-20251001" }} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  // The whole point of the fix: the shipped default model must show the chip.
  it("renders on a Claude 5 model", () => {
    render(<EffortChip session={{ ...session, model: "claude-sonnet-5" }} />)
    expect(screen.getByTestId("effort-chip")).toBeInTheDocument()
  })

  it("renders on the external rail, whose agent brings its own model", () => {
    mockRuntime = "external"
    render(<EffortChip session={{ ...session, model: "claude-haiku-4-5" }} />)
    expect(screen.getByTestId("effort-chip")).toBeInTheDocument()
  })
})

describe("label", () => {
  // The chip IS the readout — this is the state that was previously invisible
  // without opening the model popover and scrolling to its bottom.
  it("shows the session's tier by its display name, not its wire value", () => {
    render(<EffortChip session={session} />)
    const chip = screen.getByTestId("effort-chip")
    expect(chip).toHaveTextContent("Extra")
    expect(chip).toHaveAttribute("data-level", "xhigh")
  })

  it("names the tier in its accessible label", () => {
    render(<EffortChip session={session} />)
    expect(screen.getByLabelText("Thinking level: Extra")).toBeInTheDocument()
  })

  it("reads 'Auto' when the session opted out of overriding the model", () => {
    render(<EffortChip session={{ ...session, effort: undefined, thinkingLevel: "off" }} />)
    expect(screen.getByTestId("effort-chip")).toHaveTextContent("Auto")
  })

  it("derives the tier from effort alone on rows written before thinkingLevel existed", () => {
    render(<EffortChip session={{ ...session, thinkingLevel: undefined, effort: "medium" }} />)
    expect(screen.getByTestId("effort-chip")).toHaveTextContent("Medium")
  })

  // Display-only folding: the row keeps the user's real choice so it reapplies
  // once a capable surface is active again.
  it("shows what the turn will really carry when the surface cannot honour the tier", () => {
    render(
      <EffortChip
        session={{
          ...session,
          providerOverride: "deepseek",
          model: "deepseek-reasoner",
          thinkingLevel: "max",
        }}
      />
    )
    expect(screen.getByTestId("effort-chip")).toHaveTextContent("High")
  })

  it("marks the ultracode tier so it reads as a change in kind", () => {
    render(<EffortChip session={{ ...session, thinkingLevel: "ultracode" }} />)
    const chip = screen.getByTestId("effort-chip")
    expect(chip).toHaveTextContent("Ultracode")
    expect(chip.className).toContain("text-effort-ultra")
  })

  // The chip is often the only part of the control on screen when the tier
  // changes (committed from the model popover, the keyboard, or a preset), so
  // both halves animate their entrance rather than silently relabelling — and
  // they are keyed by tier, which is what makes the entrance re-fire.
  it("animates the glyph and the label when the tier changes under it", () => {
    const { rerender } = render(<EffortChip session={{ ...session, thinkingLevel: "high" }} />)
    const chip = () => screen.getByTestId("effort-chip")
    expect(chip().querySelector(".effort-glyph-pulse")).not.toBeNull()
    const label = chip().querySelector(".effort-value-rise")
    expect(label).toHaveTextContent("High")

    rerender(<EffortChip session={{ ...session, thinkingLevel: "ultracode" }} />)
    // A fresh node, not the same one relabelled: React remounted it on the key
    // change, which is the animation restart.
    expect(chip().querySelector(".effort-value-rise")).not.toBe(label)
    expect(chip()).toHaveAttribute("data-level", "ultracode")
  })
})

describe("popover", () => {
  it("opens the full selector card on click", () => {
    render(<EffortChip session={session} />)
    expect(screen.queryByTestId("effort-selector-section")).toBeNull()
    fireEvent.click(screen.getByTestId("effort-chip"))
    const card = screen.getByTestId("effort-selector-section")
    expect(card).toBeInTheDocument()
    // This popover is the tier's only surface, so the card owns the whole
    // thing and carries no divider from a copy sitting above it.
    expect(card.className).not.toContain("border-t")
  })

  it("stays shut and unfocusable while a turn is in flight", () => {
    render(<EffortChip session={session} disabled />)
    const chip = screen.getByTestId("effort-chip")
    expect(chip).toBeDisabled()
    fireEvent.click(chip)
    expect(screen.queryByTestId("effort-selector-section")).toBeNull()
  })
})

describe("EffortChip shells", () => {
  it("carries the overlay tier on a desktop pane instead of a hand-rolled shadow", () => {
    useIsMobileMock.mockReturnValue(false)
    render(<EffortChip session={session} />)
    fireEvent.click(screen.getByTestId("effort-chip"))
    const panel = screen.getByTestId("effort-panel")
    expect(panel).toHaveAttribute("data-surface-layer", "overlay")
  })

  it("opens a bottom sheet on a phone rather than a popover into the keyboard", () => {
    useIsMobileMock.mockReturnValue(true)
    render(<EffortChip session={session} />)
    fireEvent.click(screen.getByTestId("effort-chip"))
    const panel = screen.getByTestId("effort-panel")
    expect(panel).toHaveAttribute("data-slot", "drawer-content")
    // The card itself is untouched: same control, different frame.
    expect(screen.getByTestId("responsive-picker-panel")).toBeInTheDocument()
  })
})
