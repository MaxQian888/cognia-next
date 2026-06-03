import { act, fireEvent, render, screen } from "@testing-library/react"
import { GitSection } from "./git-section"
import { useSettingsStore } from "@/stores/settings"

function setSettings(commitMessageAI: unknown) {
  act(() => {
    useSettingsStore.setState({ settings: { gitSettings: { commitMessageAI } } as never })
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
})
