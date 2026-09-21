import { fireEvent, render, screen } from "@testing-library/react"
import { ComposerGhostCard, type ComposerGhostCardProps } from "./composer-ghost-card"
import type { InlineSuggestion } from "@/lib/chat/completion/inline/types"

// Keys echo — the card's copy is asserted by key, not by English wording.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("motion/react", () => jest.requireActual("../../../__mocks__/motion-react.js"))

function candidate(text: string, providerId = "builtin:ai"): InlineSuggestion {
  return { id: `${providerId}:0`, text, source: "ai", providerId, score: 0.9 }
}

function props(overrides: Partial<ComposerGhostCardProps> = {}): ComposerGhostCardProps {
  return {
    open: true,
    querying: false,
    streaming: false,
    error: false,
    ghost: "the build please",
    suggestion: candidate("fix the build please"),
    candidates: [candidate("fix the build please")],
    index: 0,
    isMobile: false,
    onAccept: jest.fn(),
    onDismiss: jest.fn(),
    onCycleTo: jest.fn(),
    onRetry: jest.fn(),
    ...overrides,
  }
}

describe("ComposerGhostCard", () => {
  it("renders nothing while closed", () => {
    render(<ComposerGhostCard {...props({ open: false })} />)
    expect(screen.queryByTestId("composer-ghost-card")).not.toBeInTheDocument()
  })

  it("shows the settled suggestion with its source and body", () => {
    render(<ComposerGhostCard {...props()} />)
    expect(screen.getByTestId("composer-ghost-card")).toBeInTheDocument()
    expect(screen.getByText("the build please")).toBeInTheDocument()
    expect(screen.getByTestId("composer-ghost-card-source")).toHaveTextContent("ghostSourceAi")
    expect(screen.getByText("ghostCardSuggestion")).toBeInTheDocument()
  })

  it("shows a thinking state while the model call is in flight", () => {
    render(
      <ComposerGhostCard
        {...props({ querying: true, ghost: "", suggestion: null, candidates: [] })}
      />
    )
    expect(screen.getByText("ghostCardThinking")).toBeInTheDocument()
  })

  it("marks the streaming state while tokens are arriving", () => {
    render(<ComposerGhostCard {...props({ streaming: true })} />)
    expect(screen.getByText("ghostCardSuggesting")).toBeInTheDocument()
    expect(screen.getByText("the build please")).toBeInTheDocument()
  })

  it("surfaces a failed round with a retry button", () => {
    const onRetry = jest.fn()
    render(
      <ComposerGhostCard
        {...props({ error: true, ghost: "", suggestion: null, candidates: [], onRetry })}
      />
    )
    expect(screen.getByTestId("composer-ghost-card-error")).toHaveTextContent("ghostCardFailed")
    fireEvent.click(screen.getByTestId("composer-ghost-card-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("does not offer retry on a healthy round", () => {
    render(<ComposerGhostCard {...props()} />)
    expect(screen.queryByTestId("composer-ghost-card-retry")).not.toBeInTheDocument()
  })

  it("accepts and dismisses from the footer buttons", () => {
    const onAccept = jest.fn()
    const onDismiss = jest.fn()
    render(<ComposerGhostCard {...props({ onAccept, onDismiss })} />)
    fireEvent.click(screen.getByText("ghostAccept"))
    fireEvent.click(screen.getByText("ghostDismiss"))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("renders one clickable dot per candidate", () => {
    const onCycleTo = jest.fn()
    render(
      <ComposerGhostCard
        {...props({
          candidates: [
            candidate("fix the build please"),
            { ...candidate("fix it"), id: "builtin:history:0", source: "history" },
          ],
          index: 0,
          onCycleTo,
        })}
      />
    )
    expect(screen.getByTestId("composer-ghost-card-dot-0")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("composer-ghost-card-dot-1")).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(screen.getByTestId("composer-ghost-card-dot-1"))
    expect(onCycleTo).toHaveBeenCalledWith(1)
  })

  it("hides the dot strip with a single candidate", () => {
    render(<ComposerGhostCard {...props()} />)
    expect(screen.queryByTestId("composer-ghost-card-dot-0")).not.toBeInTheDocument()
  })

  it("names every suggestion source in the header pill", () => {
    for (const [source, key] of [
      ["history", "ghostSourceHistory"],
      ["command", "ghostSourceCommand"],
      ["ai", "ghostSourceAi"],
      ["agent", "ghostSourceAgent"],
      ["plugin", "ghostSourcePlugin"],
    ] as const) {
      const suggestion = { ...candidate("fix x"), source }
      const { unmount } = render(<ComposerGhostCard {...props({ suggestion })} />)
      expect(screen.getByTestId("composer-ghost-card-source")).toHaveTextContent(key)
      unmount()
    }
  })

  it("drops key hints on touch devices, where Tab/Esc do not exist", () => {
    render(<ComposerGhostCard {...props({ isMobile: true })} />)
    expect(screen.queryByText("Tab")).not.toBeInTheDocument()
    expect(screen.queryByText("Esc")).not.toBeInTheDocument()
    // The labelled buttons remain — they ARE the mobile affordance.
    expect(screen.getByText("ghostAccept")).toBeInTheDocument()
    expect(screen.getByText("ghostDismiss")).toBeInTheDocument()
  })
})
