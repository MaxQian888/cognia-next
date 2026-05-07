import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { A2UIBridgeTab } from "./a2ui-bridge-tab"

const save = jest.fn()
const stateRef = { current: { a2uiDefaultEnabled: false } }

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

describe("A2UIBridgeTab", () => {
  beforeEach(() => {
    save.mockClear()
    stateRef.current = { a2uiDefaultEnabled: false }
  })

  it("renders the title, hint, and switch (off when settings is false)", () => {
    render(<A2UIBridgeTab />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("hint")).toBeInTheDocument()
    const sw = screen.getByLabelText("title")
    expect(sw).toHaveAttribute("aria-checked", "false")
  })

  it("switch is checked when settings is true", () => {
    stateRef.current = { a2uiDefaultEnabled: true }
    render(<A2UIBridgeTab />)
    const sw = screen.getByLabelText("title")
    expect(sw).toHaveAttribute("aria-checked", "true")
  })

  it("toggling the switch persists the new value", async () => {
    const user = userEvent.setup()
    render(<A2UIBridgeTab />)
    await user.click(screen.getByLabelText("title"))
    expect(save).toHaveBeenCalledWith({ a2uiDefaultEnabled: true })
  })

  it("falls back to false when settings is null", () => {
    stateRef.current = null as never
    render(<A2UIBridgeTab />)
    const sw = screen.getByLabelText("title")
    expect(sw).toHaveAttribute("aria-checked", "false")
  })
})
