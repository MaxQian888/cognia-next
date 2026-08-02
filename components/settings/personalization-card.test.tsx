/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const save = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

import { PersonalizationCard } from "./personalization-card"

beforeEach(() => {
  save.mockReset()
  storeState.settings = {}
})

describe("PersonalizationCard", () => {
  it("renders the name field + style toggle", () => {
    render(<PersonalizationCard />)
    expect(screen.getByText("personalization.nameLabel")).toBeInTheDocument()
    expect(screen.getByText("personalization.styleLabel")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "personalization.styleRich" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "personalization.styleMinimal" })).toBeInTheDocument()
  })

  it("commits the name on blur", async () => {
    const user = userEvent.setup()
    render(<PersonalizationCard />)
    const input = screen.getByPlaceholderText("personalization.namePlaceholder")
    await user.type(input, "Max")
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ userName: "Max" })
  })

  it("does not write when the name is unchanged", () => {
    storeState.settings = { userName: "Max" }
    render(<PersonalizationCard />)
    fireEvent.blur(screen.getByPlaceholderText("personalization.namePlaceholder"))
    expect(save).not.toHaveBeenCalled()
  })

  it("switches the welcome style on click", async () => {
    const user = userEvent.setup()
    render(<PersonalizationCard />)
    await user.click(screen.getByRole("button", { name: "personalization.styleMinimal" }))
    expect(save).toHaveBeenCalledWith({ welcomeStyle: "minimal" })
  })

  it("shows the restore button only when sections are hidden and clears them", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<PersonalizationCard />)
    expect(
      screen.queryByRole("button", { name: "personalization.restoreSections" })
    ).not.toBeInTheDocument()

    storeState.settings = { welcomeHidden: { tryPrompt: true } }
    rerender(<PersonalizationCard />)
    await user.click(screen.getByRole("button", { name: "personalization.restoreSections" }))
    // Restoring brings back everything the ✕ can hide on the welcome page —
    // the dismissed sections AND the usage dashboard.
    expect(save).toHaveBeenCalledWith({
      welcomeHidden: {},
      welcomeStats: { enabled: true },
    })
  })

  it("offers the restore button when only the usage dashboard was dismissed", async () => {
    const user = userEvent.setup()
    storeState.settings = { welcomeStats: { enabled: false, rangeDays: 7 } }
    render(<PersonalizationCard />)
    await user.click(screen.getByRole("button", { name: "personalization.restoreSections" }))
    // Re-enabling must not reset the rest of the dashboard's layout.
    expect(save).toHaveBeenCalledWith({
      welcomeHidden: {},
      welcomeStats: { enabled: true, rangeDays: 7 },
    })
  })

  it("keeps the restore button hidden when nothing was dismissed", () => {
    storeState.settings = { welcomeStats: { enabled: true } }
    render(<PersonalizationCard />)
    expect(
      screen.queryByRole("button", { name: "personalization.restoreSections" })
    ).not.toBeInTheDocument()
  })
})
