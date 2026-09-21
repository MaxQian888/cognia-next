/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SparklesIcon } from "lucide-react"

import {
  EmptyChatState,
  SectionHeading,
  type RecentSessionEntry,
  type StarterSample,
} from "./empty-state"

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
  it("renders the time-of-day greeting as the headline (no generic subtitle)", () => {
    render(<EmptyChatState {...baseProps()} />)
    // Heading is now the greeting slot (key echoed by the mocked translator).
    // The generic subtitle is gone — the composer's typewriter hints do that
    // work. An override subtitle still renders (see the override tests).
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.queryByText("subtitle")).not.toBeInTheDocument()
  })

  it("weaves the userName into the greeting via the named key", () => {
    render(<EmptyChatState {...baseProps()} userName="Max" />)
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("greeting.named")
  })

  // ── Welcome style (rich vs minimal) ───────────────────────────────────
  it("renders the ambient bloom in the rich style, as decoration", () => {
    render(<EmptyChatState {...baseProps()} />)
    const bloom = screen.getByTestId("welcome-bloom")
    // Texture only — it repeats nothing the copy says, so it is aria-hidden
    // and absent from the accessibility tree entirely.
    expect(bloom).toBeInTheDocument()
    expect(bloom).toHaveAttribute("aria-hidden", "true")
  })

  it("adapts the welcome to its pane width instead of the viewport width", () => {
    const { container } = render(<EmptyChatState {...baseProps()} />)
    const scroller = container.firstElementChild

    // Split view keeps the browser viewport wide while each ChatPane is narrow.
    // The layout must therefore respond to its own container width; a viewport
    // `md:` class would misfire inside a narrow pane.
    expect(scroller).toHaveClass("@container")
    expect(screen.getByRole("heading", { level: 2 }).className).toContain("@lg:text-5xl")
  })

  it("centers the hero — no two-column split", () => {
    render(<EmptyChatState {...baseProps()} />)
    const hero = screen.getByTestId("welcome-hero")
    expect(hero.className).toContain("items-center")
    expect(hero.className).not.toMatch(/\bgrid\b/)
  })

  it("drops the ambient bloom in the minimal style", () => {
    render(<EmptyChatState {...baseProps()} welcomeStyle="minimal" />)
    expect(screen.queryByTestId("welcome-bloom")).not.toBeInTheDocument()
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
    const chips = screen.getByTestId("welcome-chips")
    expect(chips).toContainElement(screen.getByRole("button", { name: "Plan my week" }))
    expect(chips).toContainElement(screen.getByRole("button", { name: "Draft an email" }))
    await user.click(screen.getByRole("button", { name: "Plan my week" }))
    expect(props.onUseSample).toHaveBeenCalledWith("Plan my week")
  })

  // ── Dev-tool starter prompts ──────────────────────────────────────────
  it("always shows the starter prompts and fires onUseSample on click", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} />)
    const starter = screen.getByRole("button", { name: /samples.exploreTitle/ })
    expect(starter).toHaveAttribute("data-slot", "button")
    await user.click(starter)
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

  it("hides the starter chips when hiddenSections.tryPrompt is set", () => {
    render(<EmptyChatState {...baseProps()} hiddenSections={{ tryPrompt: true }} />)
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "dismiss" })).not.toBeInTheDocument()
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
    // Custom heading / subtitle / starter chips replace the generic copy.
    expect(
      screen.getByRole("heading", { name: "Build or refine this workflow" })
    ).toBeInTheDocument()
    expect(screen.getByText("Describe a flow to scaffold")).toBeInTheDocument()
    // Generic dev-tool starters are gone; workflow starters are shown.
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Scaffold a workflow/ }))
    expect(props.onUseSample).toHaveBeenCalledWith("Build it for me")
  })

  it("falls back to the greeting for override fields left undefined", () => {
    const samples: StarterSample[] = [
      { key: "build", icon: SparklesIcon, title: "Scaffold a workflow", prompt: "Build it" },
    ]
    // Only `samples` provided — heading/subtitle keep the generic copy.
    render(<EmptyChatState {...baseProps()} override={{ samples }} />)
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.queryByText("subtitle")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Scaffold a workflow/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
  })

  // ── Character exemplar prompts (ADR-0030) ─────────────────────────────
  it("renders character exemplar prompts and fires onUseSample on click", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} characterSamples={["Explain recursion", "Draft a haiku"]} />)
    await user.click(screen.getByRole("button", { name: /Draft a haiku/ }))
    expect(props.onUseSample).toHaveBeenCalledWith("Draft a haiku")
  })

  it("hides the character chips when characterSamples is empty or only blanks", () => {
    const { rerender } = render(<EmptyChatState {...baseProps()} characterSamples={[]} />)
    expect(screen.queryByRole("button", { name: /Explain recursion/ })).not.toBeInTheDocument()
    rerender(<EmptyChatState {...baseProps()} characterSamples={["   ", ""]} />)
    expect(screen.queryByRole("button", { name: /Explain recursion/ })).not.toBeInTheDocument()
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
    expect(screen.getByText("sections.continue:")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Refactor auth/ }))
    expect(onResumeSession).toHaveBeenCalledWith("s1")
  })

  it("caps the quiet recent line at three entries", () => {
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
    expect(screen.getByRole("button", { name: /Session 2/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Session 3/ })).not.toBeInTheDocument()
  })

  it("hides the continue line when the recent list is empty", () => {
    render(<EmptyChatState {...baseProps()} recentSessions={[]} onResumeSession={jest.fn()} />)
    expect(screen.queryByTestId("welcome-recents")).not.toBeInTheDocument()
  })

  it("hides the continue line when onResumeSession is absent", () => {
    render(
      <EmptyChatState {...baseProps()} recentSessions={[{ id: "s1", title: "X", updatedAt: 1 }]} />
    )
    expect(screen.queryByTestId("welcome-recents")).not.toBeInTheDocument()
  })

  // ── New chat button ───────────────────────────────────────────────────
  it("keeps New chat as the primary action when the surface has no composer", async () => {
    const props = baseProps()
    const user = userEvent.setup()
    render(<EmptyChatState {...props} variant="fullscreen" />)
    // No composer (the workflow-editor chat tab) — creating a session is the
    // only way in, so the button holds the composer's slot.
    const button = screen.getByRole("button", { name: /newChat/ })
    expect(screen.queryByTestId("welcome-actions")).not.toBeInTheDocument()
    await user.click(button)
    expect(props.onCreate).toHaveBeenCalled()
  })

  it("renders NO New chat button when a composer is present — the first send creates the session", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        variant="fullscreen"
        composerSlot={<div data-testid="hero-composer" />}
      />
    )
    // The composer already creates a session on its first send, so a second
    // button doing the same thing is redundant (and discards the draft).
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId("welcome-actions")).not.toBeInTheDocument()
  })

  it("parks the execution controls under the composer they configure", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        variant="fullscreen"
        composerSlot={<div data-testid="hero-composer" />}
        executionControlsSlot={<div data-testid="exec-controls" />}
      />
    )
    const actions = screen.getByTestId("welcome-actions")
    expect(actions).toContainElement(screen.getByTestId("exec-controls"))
    expect(screen.getByTestId("welcome-composer").compareDocumentPosition(actions)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it("keeps the execution controls beside New chat when there is no composer", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        variant="fullscreen"
        executionControlsSlot={<div data-testid="exec-controls" />}
      />
    )
    expect(screen.getByTestId("exec-controls")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /newChat/ })).toBeInTheDocument()
  })

  it("hides the New chat button in the inline variant", () => {
    render(<EmptyChatState {...baseProps()} variant="inline" />)
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
  })

  it("hides it in the inline variant even when a composer is present", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        variant="inline"
        composerSlot={<div data-testid="hero-composer" />}
      />
    )
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId("welcome-actions")).not.toBeInTheDocument()
  })

  // The row's second reason to exist (housing the execution picker) must carry
  // the `fullscreen` guard too. Without it this case renders a secondary action
  // row on a surface that has never had one, and the test above stays green
  // only because it omits the slot.
  it("hides the actions row in the inline variant even with execution controls", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        variant="inline"
        composerSlot={<div data-testid="hero-composer" />}
        executionControlsSlot={<div data-testid="exec-controls" />}
      />
    )
    expect(screen.queryByTestId("welcome-actions")).not.toBeInTheDocument()
  })

  // `hideCreateAction` drops the demoted ghost. The mobile shell sets it: a
  // phone reaches a new conversation from the overflow menu, the quick-action
  // grid, and the composer itself, and this fourth control also discarded the
  // draft.
  it("drops the demoted New chat button when hideCreateAction is set", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        composerSlot={<div data-testid="hero-composer" />}
        hideCreateAction
      />
    )
    expect(screen.getByTestId("hero-composer")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
    // Nothing left to hold, so the row and its gap go too.
    expect(screen.queryByTestId("welcome-actions")).not.toBeInTheDocument()
  })

  // ...unless the execution picker still needs a home. It is a real per-turn
  // choice with nowhere else to go on this surface.
  it("keeps the actions row for execution controls under hideCreateAction", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        composerSlot={<div data-testid="hero-composer" />}
        executionControlsSlot={<div data-testid="exec-controls" />}
        hideCreateAction
      />
    )
    expect(screen.getByTestId("welcome-actions")).toBeInTheDocument()
    expect(screen.getByTestId("exec-controls")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
  })

  // The hero's own primary action answers to the same flag on surfaces that
  // render no composer at all.
  it("drops the hero New chat button when hideCreateAction is set with no composer", () => {
    render(<EmptyChatState {...baseProps()} hideCreateAction />)
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
  })

  // ── Mobile home slots (hideSamples / header / quick actions) ──────────
  it("suppresses the dev-tool starter chips when hideSamples is set", () => {
    render(<EmptyChatState {...baseProps()} hideSamples />)
    expect(screen.queryByRole("button", { name: /samples.exploreTitle/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId("welcome-chips")).not.toBeInTheDocument()
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

  // ── Usage dashboard slot ──────────────────────────────────────────────
  it("renders statsSlot below the fold, after the centered column", () => {
    render(<EmptyChatState {...baseProps()} statsSlot={<div data-testid="stats" />} />)
    const stats = screen.getByTestId("stats")
    const chips = screen.getByTestId("welcome-chips")
    expect(chips.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("omits the stats section entirely when no slot is passed", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.queryByTestId("welcome-stats-slot")).not.toBeInTheDocument()
  })
})

describe("<SectionHeading />", () => {
  it("renders trailing actions before the dismiss affordance", async () => {
    const onDismiss = jest.fn()
    const user = userEvent.setup()
    render(
      <SectionHeading
        label="Your activity"
        actions={<button type="button">range</button>}
        dismissLabel="hide"
        onDismiss={onDismiss}
      />
    )
    const action = screen.getByRole("button", { name: "range" })
    const dismiss = screen.getByRole("button", { name: "hide" })
    expect(action.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(dismiss)
    expect(onDismiss).toHaveBeenCalled()
  })

  it("renders bare when neither actions nor a dismiss handler is given", () => {
    render(<SectionHeading label="Continue" />)
    expect(screen.getByRole("heading", { level: 3, name: "Continue" })).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  // ── Reduced motion ────────────────────────────────────────────────────
  it("renders all groups with reduced motion enabled", () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^greeting\./)
    expect(screen.getByRole("button", { name: /samples.exploreTitle/ })).toBeInTheDocument()
  })
})

// ── The welcome screen's primary affordance ────────────────────────────────
describe("<EmptyChatState /> — hero composer", () => {
  it("renders the composer directly under the greeting when one is supplied", () => {
    render(<EmptyChatState {...baseProps()} composerSlot={<div data-testid="hero-composer" />} />)
    expect(screen.getByTestId("hero-composer")).toBeInTheDocument()
  })

  it("places it above the prompt chips — the box is what the page is for", () => {
    render(<EmptyChatState {...baseProps()} composerSlot={<div data-testid="hero-composer" />} />)
    const composer = screen.getByTestId("welcome-composer")
    const chips = screen.getByTestId("welcome-chips")
    // DOCUMENT_POSITION_FOLLOWING === the chips come after the composer.
    expect(composer.compareDocumentPosition(chips)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it("renders nothing extra when no composer is supplied", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.queryByTestId("welcome-composer")).not.toBeInTheDocument()
  })
})
