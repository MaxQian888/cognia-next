import { act, fireEvent, render, screen } from "@testing-library/react"
import { GitSection } from "./git-section"
import { useSettingsStore } from "@/stores/settings"

function setSettings(commitMessageAI: unknown) {
  act(() => {
    useSettingsStore.setState({ settings: { gitSettings: { commitMessageAI } } as never })
  })
}

function setPanel(panel: Record<string, unknown>) {
  act(() => {
    useSettingsStore.setState({
      settings: {
        gitSettings: { commitMessageAI: { enabled: false, conventionalCommits: true }, panel },
      } as never,
    })
  })
}

const save = jest.fn().mockResolvedValue(undefined)

beforeEach(() => {
  jest.clearAllMocks()
  act(() => {
    useSettingsStore.setState({ save } as never)
  })
  setSettings({ enabled: false, conventionalCommits: true })
})

describe("GitSection", () => {
  it("renders the AI commit toggle off with sub-options hidden", () => {
    render(<GitSection />)
    expect(screen.getByLabelText(/AI commit messages/i)).toBeInTheDocument()
    // Conventional + custom instructions hidden while disabled.
    expect(screen.queryByLabelText(/Conventional Commits/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Custom instructions/i)).not.toBeInTheDocument()
  })

  it("enables AI commit messages on toggle", () => {
    render(<GitSection />)
    fireEvent.click(screen.getByLabelText(/AI commit messages/i))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        gitSettings: expect.objectContaining({
          commitMessageAI: expect.objectContaining({ enabled: true }),
        }),
      })
    )
  })

  it("reveals conventional + custom instructions when enabled", () => {
    setSettings({ enabled: true, conventionalCommits: true })
    render(<GitSection />)
    expect(screen.getByLabelText(/Conventional Commits/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Custom instructions/i)).toBeInTheDocument()
  })

  it("saves custom instructions", () => {
    setSettings({ enabled: true, conventionalCommits: true })
    render(<GitSection />)
    fireEvent.change(screen.getByLabelText(/Custom instructions/i), {
      target: { value: "use past tense" },
    })
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        gitSettings: expect.objectContaining({
          commitMessageAI: expect.objectContaining({ customInstructions: "use past tense" }),
        }),
      })
    )
  })

  it("renders the review + explain AI toggles", () => {
    render(<GitSection />)
    expect(screen.getByLabelText(/AI code review/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/AI change explanation/i)).toBeInTheDocument()
  })

  it("enables AI code review on toggle", () => {
    render(<GitSection />)
    fireEvent.click(screen.getByLabelText(/AI code review/i))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        gitSettings: expect.objectContaining({
          reviewAI: expect.objectContaining({ enabled: true }),
        }),
      })
    )
  })

  it("enables AI change explanation on toggle", () => {
    render(<GitSection />)
    fireEvent.click(screen.getByLabelText(/AI change explanation/i))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        gitSettings: expect.objectContaining({
          explainAI: expect.objectContaining({ enabled: true }),
        }),
      })
    )
  })

  it("reveals the review provider override when enabled", () => {
    act(() => {
      useSettingsStore.setState({
        settings: {
          gitSettings: {
            commitMessageAI: { enabled: false, conventionalCommits: true },
            reviewAI: { enabled: true },
          },
        } as never,
      })
    })
    render(<GitSection />)
    expect(screen.getByTestId("git-ai-review-provider")).toBeInTheDocument()
  })

  it("renders the Panel & workflow card with its guardrail toggles", () => {
    render(<GitSection />)
    expect(screen.getByLabelText(/Confirm before discarding/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Confirm before force push/i)).toBeInTheDocument()
  })

  it("saves a guardrail toggle to the panel prefs", () => {
    render(<GitSection />)
    // Default is on → toggling turns it off, persisted under gitSettings.panel.
    fireEvent.click(screen.getByLabelText(/Confirm before discarding/i))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        gitSettings: expect.objectContaining({
          panel: expect.objectContaining({ confirmDiscard: false }),
        }),
      })
    )
  })

  it("shows the interval input only when auto-fetch is enabled", () => {
    const { rerender } = render(<GitSection />)
    expect(screen.queryByTestId("git-auto-fetch-interval")).not.toBeInTheDocument()
    setPanel({ autoFetch: true })
    rerender(<GitSection />)
    expect(screen.getByTestId("git-auto-fetch-interval")).toBeInTheDocument()
  })
})
