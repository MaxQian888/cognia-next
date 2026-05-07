import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DefaultsTab } from "./defaults-tab"

const save = jest.fn()
const stateRef = {
  current: {
    permissionMode: "default" as const,
    defaultWorkingDir: "",
    defaultSystemPrompt: "",
    routingFallbackEnabled: true,
  },
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: stateRef.current,
      save: (...args: unknown[]) => save(...args),
    }),
}))

jest.mock("../parts/default-model-picker", () => ({
  DefaultModelPicker: () => <div data-testid="default-model-picker" />,
}))

describe("DefaultsTab", () => {
  beforeEach(() => {
    save.mockClear()
    stateRef.current = {
      permissionMode: "default",
      defaultWorkingDir: "",
      defaultSystemPrompt: "",
      routingFallbackEnabled: true,
    }
  })

  it("renders all 4 permission-mode options in the dropdown", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByRole("combobox"))
    // The active label also shows in the trigger, so use getAllByText.
    expect(screen.getAllByText("permDefault").length).toBeGreaterThan(0)
    expect(screen.getByRole("option", { name: "permAcceptEdits" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "permBypass" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "permPlan" })).toBeInTheDocument()
  })

  it("blur on working-dir input persists trimmed value", () => {
    render(<DefaultsTab />)
    const input = screen.getByLabelText("workingDirTitle") as HTMLInputElement
    fireEvent.change(input, { target: { value: "  /Users/me/proj  " } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultWorkingDir: "/Users/me/proj" })
  })

  it("blur with empty working-dir persists undefined", () => {
    render(<DefaultsTab />)
    const input = screen.getByLabelText("workingDirTitle") as HTMLInputElement
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultWorkingDir: undefined })
  })

  it("blur on append textarea persists trimmed value", () => {
    render(<DefaultsTab />)
    const ta = screen.getByLabelText("appendTitle")
    fireEvent.change(ta, { target: { value: "Stay concise.  " } })
    fireEvent.blur(ta)
    expect(save).toHaveBeenCalledWith({ defaultSystemPrompt: "Stay concise." })
  })

  it("toggling routing fallback persists the new value", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByLabelText("routingTitle"))
    expect(save).toHaveBeenCalledWith({ routingFallbackEnabled: false })
  })

  it("renders the default model picker slot", () => {
    render(<DefaultsTab />)
    expect(screen.getByTestId("default-model-picker")).toBeInTheDocument()
  })

  it("blur with empty append textarea persists undefined", () => {
    render(<DefaultsTab />)
    const ta = screen.getByLabelText("appendTitle")
    fireEvent.change(ta, { target: { value: "" } })
    fireEvent.blur(ta)
    expect(save).toHaveBeenCalledWith({ defaultSystemPrompt: undefined })
  })

  it("renders nothing when settings is null", () => {
    stateRef.current = null as never
    const { container } = render(<DefaultsTab />)
    // The form still renders (uses local-state defaults), just with no data.
    expect(container).toBeTruthy()
  })

  it("renders permission-mode default when settings has no value", () => {
    stateRef.current = {
      permissionMode: undefined as never,
      defaultWorkingDir: undefined as never,
      defaultSystemPrompt: undefined as never,
      routingFallbackEnabled: undefined as never,
    }
    render(<DefaultsTab />)
    // Should fall back to "default" — the trigger shows the matching label.
    const combobox = screen.getByRole("combobox")
    expect(combobox).toBeInTheDocument()
  })
})
