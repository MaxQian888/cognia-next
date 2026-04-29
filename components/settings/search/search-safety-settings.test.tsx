import { render, screen, fireEvent } from "@testing-library/react"

const setEnabledMock = jest.fn()
const setLevelMock = jest.fn()

let settings: {
  searchSafeSearchEnabled?: boolean
  searchSafeSearchLevel?: "off" | "moderate" | "strict"
} = {}

jest.mock("@/stores/settings-store", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: typeof settings
      setSearchSafeSearchEnabled: typeof setEnabledMock
      setSearchSafeSearchLevel: typeof setLevelMock
    }) => T
  ) =>
    selector({
      settings,
      setSearchSafeSearchEnabled: setEnabledMock,
      setSearchSafeSearchLevel: setLevelMock,
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SearchSafetySettings } from "./search-safety-settings"

beforeEach(() => {
  setEnabledMock.mockReset()
  setLevelMock.mockReset()
  settings = {}
})

describe("SearchSafetySettings", () => {
  it("renders title and description", () => {
    render(<SearchSafetySettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("description")).toBeInTheDocument()
  })

  it("hides level controls when disabled", () => {
    settings = { searchSafeSearchEnabled: false }
    render(<SearchSafetySettings />)
    expect(screen.queryByText("level")).not.toBeInTheDocument()
  })

  it("shows level buttons when enabled", () => {
    settings = { searchSafeSearchEnabled: true, searchSafeSearchLevel: "moderate" }
    render(<SearchSafetySettings />)
    expect(screen.getByText("off")).toBeInTheDocument()
    expect(screen.getByText("moderate")).toBeInTheDocument()
    expect(screen.getByText("strict")).toBeInTheDocument()
  })

  it("toggles enabled via switch", () => {
    settings = { searchSafeSearchEnabled: false }
    render(<SearchSafetySettings />)
    fireEvent.click(screen.getByRole("switch"))
    expect(setEnabledMock).toHaveBeenCalledWith(true)
  })

  it("changes level when button clicked", () => {
    settings = { searchSafeSearchEnabled: true, searchSafeSearchLevel: "moderate" }
    render(<SearchSafetySettings />)
    fireEvent.click(screen.getByText("strict"))
    expect(setLevelMock).toHaveBeenCalledWith("strict")
  })
})
