import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ComposerAssistanceCard } from "./composer-assistance-card"

const save = jest.fn()
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings, save }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

describe("ComposerAssistanceCard", () => {
  beforeEach(() => {
    save.mockReset()
    mockSettings = { composerAssistance: {} }
  })

  it("defaults enhance / starters / followUps ON and ghost OFF", () => {
    render(<ComposerAssistanceCard />)
    expect(screen.getByLabelText("enhance.label")).toBeChecked()
    expect(screen.getByLabelText("starters.label")).toBeChecked()
    expect(screen.getByLabelText("followUps.label")).toBeChecked()
    expect(screen.getByLabelText("ghostText.label")).not.toBeChecked()
    // Debounce input hidden while ghost text is off.
    expect(screen.queryByLabelText("ghostText.debounceLabel")).not.toBeInTheDocument()
  })

  it("defaults the free local completion tier ON", () => {
    // The model tier is opt-in, so the local tier is what most users get; it
    // must not inherit the model tier's default-off.
    render(<ComposerAssistanceCard />)
    expect(screen.getByLabelText("ghostTextLocal.label")).toBeChecked()
  })

  it("toggles the local tier off without disturbing the model tier", async () => {
    const user = userEvent.setup()
    mockSettings = { composerAssistance: { ghostText: { enabled: true } } }
    render(<ComposerAssistanceCard />)
    await user.click(screen.getByLabelText("ghostTextLocal.label"))
    expect(save).toHaveBeenCalledWith({
      composerAssistance: { ghostText: { enabled: true, local: false } },
    })
  })

  it("honours an explicitly disabled local tier", () => {
    mockSettings = { composerAssistance: { ghostText: { local: false } } }
    render(<ComposerAssistanceCard />)
    expect(screen.getByLabelText("ghostTextLocal.label")).not.toBeChecked()
  })

  it("toggles enhance off", async () => {
    const user = userEvent.setup()
    render(<ComposerAssistanceCard />)
    await user.click(screen.getByLabelText("enhance.label"))
    expect(save).toHaveBeenCalledWith({ composerAssistance: { enhance: { enabled: false } } })
  })

  it("enabling ghost text reveals the debounce input", async () => {
    const user = userEvent.setup()
    render(<ComposerAssistanceCard />)
    await user.click(screen.getByLabelText("ghostText.label"))
    expect(save).toHaveBeenCalledWith({
      composerAssistance: { ghostText: { enabled: true } },
    })
  })

  it("shows and clamps the debounce input when ghost text is on", async () => {
    mockSettings = { composerAssistance: { ghostText: { enabled: true, debounceMs: 500 } } }
    render(<ComposerAssistanceCard />)
    const input = screen.getByLabelText("ghostText.debounceLabel")
    expect(input).toBeInTheDocument()
    const user = userEvent.setup()
    await user.clear(input)
    await user.type(input, "99999")
    // Last keystroke clamps to the max.
    expect(save).toHaveBeenLastCalledWith({
      composerAssistance: { ghostText: { enabled: true, debounceMs: 2000 } },
    })
  })

  it("toggles starters off", async () => {
    const user = userEvent.setup()
    render(<ComposerAssistanceCard />)
    await user.click(screen.getByLabelText("starters.label"))
    expect(save).toHaveBeenCalledWith({
      composerAssistance: { suggestions: { starters: false } },
    })
  })

  it("toggles followUps off", async () => {
    const user = userEvent.setup()
    render(<ComposerAssistanceCard />)
    await user.click(screen.getByLabelText("followUps.label"))
    expect(save).toHaveBeenCalledWith({
      composerAssistance: { suggestions: { followUps: false } },
    })
  })

  it("clamps the debounce up from below the floor", () => {
    mockSettings = { composerAssistance: { ghostText: { enabled: true, debounceMs: 500 } } }
    render(<ComposerAssistanceCard />)
    const input = screen.getByLabelText("ghostText.debounceLabel")
    fireEvent.change(input, { target: { value: "10" } })
    expect(save).toHaveBeenLastCalledWith({
      composerAssistance: { ghostText: { enabled: true, debounceMs: 200 } },
    })
  })

  it("reflects persisted disabled state", () => {
    mockSettings = {
      composerAssistance: {
        enhance: { enabled: false },
        suggestions: { followUps: false },
      },
    }
    render(<ComposerAssistanceCard />)
    expect(screen.getByLabelText("enhance.label")).not.toBeChecked()
    expect(screen.getByLabelText("followUps.label")).not.toBeChecked()
    expect(screen.getByLabelText("starters.label")).toBeChecked()
  })
})
