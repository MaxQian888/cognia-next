/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}))

const save = jest.fn().mockResolvedValue(undefined)
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

import { InstructionsCard } from "./instructions-card"

beforeEach(() => {
  save.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  storeState.settings = {}
})

describe("InstructionsCard", () => {
  it("renders the core controls with defaults", () => {
    render(<InstructionsCard />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByLabelText("enabled")).toBeChecked()
    expect(screen.getByLabelText("loadProjectAgents")).toBeChecked()
    // global path input visible because includeGlobal defaults on
    expect(screen.getByLabelText("globalPath")).toBeInTheDocument()
  })

  it("hydrates from existing settings", () => {
    storeState.settings = {
      instructions: {
        enabled: true,
        mode: "nearest",
        includeGlobal: false,
        loadProjectAgents: false,
        extraPaths: ["docs/a.md", "rules/*.md"],
      },
    }
    render(<InstructionsCard />)
    expect(screen.getByLabelText("loadProjectAgents")).not.toBeChecked()
    // includeGlobal off → no path input
    expect(screen.queryByLabelText("globalPath")).not.toBeInTheDocument()
    expect(screen.getByLabelText("extraPaths")).toHaveValue("docs/a.md\nrules/*.md")
  })

  it("saves the assembled config", async () => {
    const user = userEvent.setup()
    render(<InstructionsCard />)
    await user.type(screen.getByLabelText("extraPaths"), "docs/x.md")
    await user.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({
      instructions: expect.objectContaining({
        enabled: true,
        mode: "layered",
        includeGlobal: true,
        loadProjectAgents: true,
        extraPaths: ["docs/x.md"],
      }),
    })
    expect(toastSuccess).toHaveBeenCalledWith("saved")
  })

  it("disables dependent controls when disabled", async () => {
    const user = userEvent.setup()
    render(<InstructionsCard />)
    await user.click(screen.getByLabelText("enabled"))
    expect(screen.getByLabelText("extraPaths")).toBeDisabled()
  })

  it("applies default fallbacks when hydrating from a partial config", () => {
    storeState.settings = { instructions: {} }
    render(<InstructionsCard />)
    // empty object → every `?? default` right-hand branch is taken
    expect(screen.getByLabelText("enabled")).toBeChecked()
    expect(screen.getByLabelText("includeGlobal")).toBeChecked()
  })

  it("hides the global path input and edits the dependent controls", async () => {
    const user = userEvent.setup()
    render(<InstructionsCard />)
    await user.type(screen.getByLabelText("globalPath"), "/g/AGENTS.md")
    await user.click(screen.getByLabelText("loadProjectAgents")) // off
    await user.click(screen.getByLabelText("includeGlobal")) // off → input disappears
    expect(screen.queryByLabelText("globalPath")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith({
      instructions: expect.objectContaining({
        globalPath: "/g/AGENTS.md",
        includeGlobal: false,
        loadProjectAgents: false,
      }),
    })
  })

  it("changes the nesting mode via the select", async () => {
    const user = userEvent.setup()
    render(<InstructionsCard />)
    await user.click(screen.getByRole("combobox"))
    await user.click(screen.getByRole("option", { name: "mode.nearest" }))
    await user.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith({
      instructions: expect.objectContaining({ mode: "nearest" }),
    })
  })

  it("surfaces a save failure as an error toast", async () => {
    save.mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    render(<InstructionsCard />)
    await user.click(screen.getByRole("button", { name: "save" }))
    expect(toastError).toHaveBeenCalledWith("boom")
  })
})
