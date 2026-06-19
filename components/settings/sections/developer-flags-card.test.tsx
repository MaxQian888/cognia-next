import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DeveloperFlagsCard } from "./developer-flags-card"

const save = jest.fn()
const stateRef = {
  current: {
    debugMode: undefined as boolean | undefined,
    developer: undefined as { chatMiddlewareExecution?: boolean } | undefined,
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

// SettingsToggle renders the switches in declaration order: debug, then middleware.
const debugSwitch = () => screen.getAllByRole("switch")[0]
const middlewareSwitch = () => screen.getAllByRole("switch")[1]

describe("DeveloperFlagsCard", () => {
  beforeEach(() => {
    save.mockClear()
    stateRef.current = { debugMode: undefined, developer: undefined }
  })

  it("renders both developer toggles unchecked by default", () => {
    render(<DeveloperFlagsCard />)
    expect(debugSwitch()).toHaveAttribute("data-state", "unchecked")
    expect(middlewareSwitch()).toHaveAttribute("data-state", "unchecked")
  })

  it("enabling debug mode persists true", async () => {
    const user = userEvent.setup()
    render(<DeveloperFlagsCard />)
    await user.click(debugSwitch())
    expect(save).toHaveBeenCalledWith({ debugMode: true })
  })

  it("disabling debug mode persists undefined (drop the key)", async () => {
    stateRef.current = { debugMode: true, developer: undefined }
    const user = userEvent.setup()
    render(<DeveloperFlagsCard />)
    expect(debugSwitch()).toHaveAttribute("data-state", "checked")
    await user.click(debugSwitch())
    expect(save).toHaveBeenCalledWith({ debugMode: undefined })
  })

  it("toggling chat middleware merges into the developer object", async () => {
    stateRef.current = { debugMode: undefined, developer: { chatMiddlewareExecution: false } }
    const user = userEvent.setup()
    render(<DeveloperFlagsCard />)
    await user.click(middlewareSwitch())
    expect(save).toHaveBeenCalledWith({
      developer: { chatMiddlewareExecution: true },
    })
  })

  it("reads an existing checked chat-middleware flag", () => {
    stateRef.current = { debugMode: undefined, developer: { chatMiddlewareExecution: true } }
    render(<DeveloperFlagsCard />)
    expect(middlewareSwitch()).toHaveAttribute("data-state", "checked")
  })
})
