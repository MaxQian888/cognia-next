import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_SOURCE_CONTROL_PANEL_PREFS } from "@/lib/git/panel-prefs"

const setters = {
  setDiffView: jest.fn(),
  setIgnoreWhitespace: jest.fn(),
  setBranchSort: jest.fn(),
  setDefaultTimelineView: jest.fn(),
  reset: jest.fn(),
}
let prefs = { ...DEFAULT_SOURCE_CONTROL_PANEL_PREFS }
let isDefault = true

jest.mock("@/hooks/git/use-source-control-prefs", () => ({
  useSourceControlPrefs: () => ({ prefs, isDefault, ...setters }),
}))

import { SourceControlViewSettings } from "./view-settings"

beforeEach(() => {
  jest.clearAllMocks()
  prefs = { ...DEFAULT_SOURCE_CONTROL_PANEL_PREFS }
  isDefault = true
})

describe("SourceControlViewSettings", () => {
  it("switches the diff view mode", async () => {
    const user = userEvent.setup()
    render(<SourceControlViewSettings />)
    await user.click(screen.getByRole("radio", { name: "Inline" }))
    expect(setters.setDiffView).toHaveBeenCalledWith("inline")
  })

  it("toggles ignore-whitespace", async () => {
    const user = userEvent.setup()
    render(<SourceControlViewSettings />)
    await user.click(screen.getByLabelText("Ignore whitespace"))
    expect(setters.setIgnoreWhitespace).toHaveBeenCalledWith(true)
  })

  it("sets the branch sort mode", async () => {
    const user = userEvent.setup()
    render(<SourceControlViewSettings />)
    await user.click(screen.getByRole("radio", { name: "Name (A–Z)" }))
    expect(setters.setBranchSort).toHaveBeenCalledWith("name")
  })

  it("sets the default timeline view", async () => {
    const user = userEvent.setup()
    render(<SourceControlViewSettings />)
    await user.click(screen.getByRole("radio", { name: "Graph" }))
    expect(setters.setDefaultTimelineView).toHaveBeenCalledWith("graph")
  })

  it("disables reset at defaults and enables it once customized", async () => {
    const { rerender } = render(<SourceControlViewSettings />)
    expect(screen.getByTestId("sc-view-settings-reset")).toBeDisabled()

    isDefault = false
    rerender(<SourceControlViewSettings />)
    const resetBtn = screen.getByTestId("sc-view-settings-reset")
    expect(resetBtn).not.toBeDisabled()
    await userEvent.setup().click(resetBtn)
    expect(setters.reset).toHaveBeenCalled()
  })
})
