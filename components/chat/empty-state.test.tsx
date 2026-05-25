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
  it("renders the greeting header", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
    expect(screen.getByText("subtitle")).toBeInTheDocument()
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

  it("falls back to generic copy for override fields left undefined", () => {
    const samples: StarterSample[] = [
      { key: "build", icon: SparklesIcon, title: "Scaffold a workflow", prompt: "Build it" },
    ]
    // Only `samples` provided — heading/subtitle/section keep the generic keys.
    render(<EmptyChatState {...baseProps()} override={{ samples }} />)
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
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

  // ── Capability entries ────────────────────────────────────────────────
  it("hides the capability group when onNavigate is absent", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.queryByText("sections.quickStart")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "capabilities.workflows" })).not.toBeInTheDocument()
  })

  it("renders capability cards and navigates to the deep-link on click", async () => {
    const onNavigate = jest.fn()
    const user = userEvent.setup()
    render(<EmptyChatState {...baseProps()} onNavigate={onNavigate} />)
    expect(screen.getByText("sections.quickStart")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "capabilities.workflows" }))
    expect(onNavigate).toHaveBeenCalledWith("/settings?section=workflows&wfTab=templates")
  })

  it("activates a capability card via Enter, Space, and ignores other keys", async () => {
    const onNavigate = jest.fn()
    const user = userEvent.setup()
    render(<EmptyChatState {...baseProps()} onNavigate={onNavigate} />)
    const card = screen.getByRole("button", { name: "capabilities.connectors" })
    card.focus()
    await user.keyboard("{Enter}")
    await user.keyboard(" ")
    await user.keyboard("a")
    expect(onNavigate).toHaveBeenCalledTimes(2)
    expect(onNavigate).toHaveBeenCalledWith("/settings?section=connections")
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

  // ── composerSlot (centered-composer layout) ───────────────────────────
  it("renders composerSlot between the greeting and the suggestion groups", () => {
    render(
      <EmptyChatState
        {...baseProps()}
        variant="inline"
        composerSlot={<div data-testid="composer-slot" />}
      />
    )
    const slot = screen.getByTestId("composer-slot")
    const title = screen.getByRole("heading", { name: "title" })
    const tryHeading = screen.getByText("sections.tryPrompt")
    // greeting → composerSlot → suggestion groups
    expect(title.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(slot.compareDocumentPosition(tryHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("omits the composerSlot region when not provided", () => {
    render(<EmptyChatState {...baseProps()} />)
    expect(screen.queryByTestId("composer-slot")).not.toBeInTheDocument()
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

  it("hides the New chat button when a composerSlot is present", () => {
    render(<EmptyChatState {...baseProps()} variant="fullscreen" composerSlot={<div />} />)
    expect(screen.queryByRole("button", { name: /newChat/ })).not.toBeInTheDocument()
  })

  // ── Reduced motion ────────────────────────────────────────────────────
  it("renders all groups with reduced motion enabled", () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(<EmptyChatState {...baseProps()} onNavigate={jest.fn()} />)
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
    expect(screen.getByText("sections.quickStart")).toBeInTheDocument()
    expect(screen.getByText("sections.tryPrompt")).toBeInTheDocument()
  })
})
