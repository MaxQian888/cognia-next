/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SparklesIcon } from "lucide-react"

import { EmptyChatState, type RecentSessionEntry, type StarterSample } from "./empty-state"

// next-intl: echo the key so assertions can target stable strings; stub the
// locale-aware relative-time formatter used by the "Continue" group.
const mockRelativeTime = jest.fn((value: number | Date) => `rel:${Number(value)}`)
const MOCK_NOW = new Date("2026-05-25T00:00:00Z")
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ relativeTime: mockRelativeTime }),
  // Provide a stable render-time "now" so relativeTime gets an explicit
  // anchor (mirrors the component's useNow() usage).
  useNow: () => MOCK_NOW,
}))

// Keep real `motion` (jsdom-safe, as the featured-carousel test proves) but
// make reduced-motion controllable for branch coverage.
jest.mock("motion/react", () => {
  const actual = jest.requireActual("motion/react")
  return { ...actual, useReducedMotion: jest.fn(() => false) }
})

import { useReducedMotion } from "motion/react"
const mockUseReducedMotion = useReducedMotion as jest.Mock

afterEach(() => {
  mockUseReducedMotion.mockReturnValue(false)
  jest.clearAllMocks()
})

function baseProps() {
  return {
    onCreate: jest.fn(),
    onUseSample: jest.fn(),
  }
}

describe("<EmptyChatState />", () => {
  it("renders the time-of-day greeting header + subtitle", () => {
    render(<EmptyChatState {...baseProps()} />)
    // Heading is now the greeting slot (key echoed by the mocked translator).
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.getByText("subtitle")).toBeInTheDocument()
  })

  it("weaves the userName into the greeting via the named key", () => {
    render(<EmptyChatState {...baseProps()} userName="Max" />)
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("greeting.named")
  })

  // ── Welcome style (rich vs minimal) ───────────────────────────────────
  it("renders the aurora backdrop in the rich style", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.getByTestId("welcome-aurora")).toBeInTheDocument()
  })

  it("drops the aurora in the minimal style", () => {
    render(<EmptyChatState {...baseProps()} welcomeStyle="minimal" />)
    expect(screen.queryByTestId("welcome-aurora")).not.toBeInTheDocument()
  })

  it("shows the style toggle only when onToggleStyle is provided and fires the opposite style", async () => {
    const onToggleStyle = jest.fn()
    const user = userEvent.setup()
    const { rerender } = render(<EmptyChatState {...baseProps()} />)
    expect(screen.queryByRole("button", { name: "style.toggleLabel" })).not.toBeInTheDocument()
    rerender(<EmptyChatState {...baseProps()} onToggleStyle={onToggleStyle} />)
    await user.click(screen.getByRole("button", { name: "style.toggleLabel" }))
    // Default style is "rich" → toggling targets "minimal".
    expect(onToggleStyle).toHaveBeenCalledWith("minimal")
  })

  it("toggles back to rich from the minimal style", async () => {
    const onToggleStyle = jest.fn()
    const user = userEvent.setup()
    render(<EmptyChatState {...baseProps()} welcomeStyle="minimal" onToggleStyle={onToggleStyle} />)
    expect(screen.getByText("style.rich")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "style.toggleLabel" }))
    expect(onToggleStyle).toHaveBeenCalledWith("rich")
  })

  it("renders the full minimal layout (brand, quick actions, outline New chat)", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        welcomeStyle="minimal"
        variant="fullscreen"
        quickActionsSlot={<div data-testid="quick-actions" />}
      />
    )
    // Minimal heading (no action line), brand, quick actions, and the New chat
    // button (outline variant) all render together.
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.getByTestId("quick-actions")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /newChat/ })).toBeInTheDocument()
  })

  // ── AI starter suggestion chips ───────────────────────────────────────
  it("renders model-suggested prompts as suggestion chips and fires onUseSample", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} aiSamples={["Plan my week", "  ", "Draft an email"]} />)
    // Blank entries are filtered out; only the two real prompts become chips.
    expect(screen.getByTestId("ai-starters")).toBeInTheDocument()
    expect(screen.getByText("sections.aiPrompts")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Plan my week" }))
    expect(props.onUseSample).toHaveBeenCalledWith("Plan my week")
  })

  // ── Dev-tool starter prompts ──────────────────────────────────────────
  it("always shows the starter prompts and fires onUseSample on click", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} />)
    expect(screen.getByText("sections.tryPrompt")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /samples.exploreTitle/ }))
    expect(props.onUseSample).toHaveBeenCalledWith("samples.explorePrompt")
  })

  it("activates a starter card via Enter, Space, and ignores other keys", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} />)
    const card = screen.getByRole("button", { name: /samples.reviewTitle/ })
    card.focus()
    await user.keyboard("{Enter}")
    await user.keyboard(" ")
    await user.keyboard("a")
    expect(props.onUseSample).toHaveBeenCalledTimes(2)
    expect(props.onUseSample).toHaveBeenCalledWith("samples.reviewPrompt")
  })

  // ── Section dismissal (tryPrompt) ─────────────────────────────────────
  it("shows ✕ on Try a prompt and fires onDismissSection", async () => {
    const onDismissSection = jest.fn()
    const user = userEvent.setup()
    render(<EmptyChatState {...baseProps()} onDismissSection={onDismissSection} />)
    const dismissers = screen.getAllByRole("button", { name: "dismiss" })
    expect(dismissers).toHaveLength(1)
    await user.click(dismissers[0])
    expect(onDismissSection).toHaveBeenCalledWith("tryPrompt")
  })

  it("omits the ✕ affordance when onDismissSection is absent", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.queryByRole("button", { name: "dismiss" })).not.toBeInTheDocument()
  })

  it("hides Try a prompt when hiddenSections.tryPrompt is set", () => {
    render(<EmptyChatState {...baseProps()} hiddenSections={{ tryPrompt: true }} />)
    expect(screen.queryByText("sections.tryPrompt")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
  })

  // ── Surface-specific override (workflow editor chat tab) ─────────────
  it("renders override copy + starter cards in place of the generic ones", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    const samples: StarterSample[] = [
      { key: "build", icon: SparklesIcon, title: "Scaffold a workflow", prompt: "Build it for me" },
      { key: "explain", icon: SparklesIcon, title: "Explain this workflow", prompt: "Explain it" },
    ]
    render(
      <EmptyChatState
        {...props}
        override={{
          title: "Build or refine this workflow",
          subtitle: "Describe a flow to scaffold",
          samplesHeading: "Workflow starters",
          samples,
        }}
      />
    )
    // Custom heading / subtitle / section heading replace the generic copy.
    expect(
      screen.getByRole("heading", { name: "Build or refine this workflow" })
    ).toBeInTheDocument()
    expect(screen.getByText("Describe a flow to scaffold")).toBeInTheDocument()
    expect(screen.getByText("Workflow starters")).toBeInTheDocument()
    expect(screen.queryByText("sections.tryPrompt")).not.toBeInTheDocument()
    // Generic dev-tool starters are gone; workflow starters are shown.
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Scaffold a workflow/ }))
    expect(props.onUseSample).toHaveBeenCalledWith("Build it for me")
  })

  it("falls back to the greeting for override fields left undefined", () => {
    const samples: StarterSample[] = [
      { key: "build", icon: SparklesIcon, title: "Scaffold a workflow", prompt: "Build it" },
    ]
    // Only `samples` provided — heading/subtitle/section keep the generic copy.
    render(<EmptyChatState {...baseProps()} override={{ samples }} />)
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.getByText("subtitle")).toBeInTheDocument()
    expect(screen.getByText("sections.tryPrompt")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Scaffold a workflow/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
  })

  // ── Character exemplar prompts (ADR-0030) ─────────────────────────────
  it("renders character exemplar prompts and fires onUseSample on click", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} characterSamples={["Explain recursion", "Draft a haiku"]} />)
    expect(screen.getByText("sections.characterPrompts")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Draft a haiku/ }))
    expect(props.onUseSample).toHaveBeenCalledWith("Draft a haiku")
  })

  it("hides the character group when characterSamples is empty or only blanks", () => {
    const { rerender } = render(<EmptyChatState {...baseProps()} characterSamples={[]} />)
    expect(screen.queryByText("sections.characterPrompts")).not.toBeInTheDocument()
    rerender(<EmptyChatState {...baseProps()} characterSamples={["   ", ""]} />)
    expect(screen.queryByText("sections.characterPrompts")).not.toBeInTheDocument()
  })

  it("activates a character prompt card via Enter / Space", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} characterSamples={["Summarize this"]} />)
    const card = screen.getByRole("button", { name: /Summarize this/ })
    card.focus()
    await user.keyboard("{Enter}")
    await user.keyboard(" ")
    expect(props.onUseSample).toHaveBeenCalledTimes(2)
    expect(props.onUseSample).toHaveBeenCalledWith("Summarize this")
  })

  // ── Recent sessions ───────────────────────────────────────────────────
  it("renders recent sessions and resumes the picked one", async () => {
    const onResumeSession = jest.fn()
    const user = userEvent.setup()
    const recentSessions: RecentSessionEntry[] = [
      { id: "s1", title: "Refactor auth", updatedAt: Date.now() - 60_000 },
      { id: "s2", title: "Triage bug", updatedAt: Date.now() - 3_600_000 },
    ]
    render(
      <EmptyChatState
        {...baseProps()}
        recentSessions={recentSessions}
        onResumeSession={onResumeSession}
      />
    )
    expect(screen.getByText("sections.continue")).toBeInTheDocument()
    // Timestamps go through next-intl's locale-aware relativeTime (no
    // hard-coded English), anchored to an explicit render-time "now".
    expect(mockRelativeTime).toHaveBeenCalledWith(recentSessions[0].updatedAt, MOCK_NOW)
    await user.click(screen.getByRole("button", { name: /Refactor auth/ }))
    expect(onResumeSession).toHaveBeenCalledWith("s1")
  })

  it("caps the recent list at four entries", () => {
    const recentSessions: RecentSessionEntry[] = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      updatedAt: i,
    }))
    render(
      <EmptyChatState
        {...baseProps()}
        recentSessions={recentSessions}
        onResumeSession={jest.fn()}
      />
    )
    expect(screen.getByRole("button", { name: /Session 0/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Session 3/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Session 4/ })).not.toBeInTheDocument()
  })

  it("hides the continue group when the recent list is empty", () => {
    render(<EmptyChatState {...baseProps()} recentSessions={[]} onResumeSession={jest.fn()} />)
    expect(screen.queryByText("sections.continue")).not.toBeInTheDocument()
  })

  it("hides the continue group when onResumeSession is absent", () => {
    render(
      <EmptyChatState {...baseProps()} recentSessions={[{ id: "s1", title: "X", updatedAt: 1 }]} />
    )
    expect(screen.queryByText("sections.continue")).not.toBeInTheDocument()
  })

  // ── New chat button ───────────────────────────────────────────────────
  it("shows the New chat button on the fullscreen welcome and fires onCreate", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} variant="fullscreen" />)
    await user.click(screen.getByRole("button", { name: /newChat/ }))
    expect(props.onCreate).toHaveBeenCalled()
  })

  it("hides the New chat button in the inline variant", () => {
    render(<EmptyChatState {...baseProps()} variant="inline" />)
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
  })

  // ── Mobile home slots (hideSamples / header / quick actions) ──────────
  it("suppresses the dev-tool starters when hideSamples is set", () => {
    render(<EmptyChatState {...baseProps()} hideSamples />)
    expect(screen.queryByText("sections.tryPrompt")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
  })

  it("renders headerExtraSlot above the greeting", () => {
    render(<EmptyChatState {...baseProps()} headerExtraSlot={<div data-testid="header-extra" />} />)
    const extra = screen.getByTestId("header-extra")
    const title = screen.getByRole("heading", { level: 2 })
    // headerExtraSlot precedes the greeting in document order.
    expect(extra.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("renders quickActionsSlot", () => {
    render(
      <EmptyChatState {...baseProps()} quickActionsSlot={<div data-testid="quick-actions" />} />
    )
    expect(screen.getByTestId("quick-actions")).toBeInTheDocument()
  })

  // ── Reduced motion ────────────────────────────────────────────────────
  it("renders all groups with reduced motion enabled", () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.getByText("sections.tryPrompt")).toBeInTheDocument()
  })
})
