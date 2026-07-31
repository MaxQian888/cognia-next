import { render, screen, fireEvent } from "@testing-library/react"

let settings: { searchProviders?: Record<string, unknown> } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: typeof settings }) => T) =>
    selector({ settings }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SearchSettingsNav } from "./search-settings-nav"

beforeEach(() => {
  settings = {
    searchProviders: {
      tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      brave: { providerId: "brave", apiKey: "", enabled: false, priority: 2 },
    },
  }
})

describe("SearchSettingsNav", () => {
  it("renders all six section buttons", () => {
    render(<SearchSettingsNav active="basics" onSelect={jest.fn()} />)
    expect(screen.getAllByRole("button")).toHaveLength(6)
    expect(screen.getByText("nav.basics")).toBeInTheDocument()
    expect(screen.getByText("nav.diagnostics")).toBeInTheDocument()
  })

  it("marks the active section with aria-current", () => {
    render(<SearchSettingsNav active="behavior" onSelect={jest.fn()} />)
    const active = screen.getByText("nav.behavior").closest("button")
    expect(active).toHaveAttribute("aria-current", "page")
  })

  it("shows the configured/total badge on the providers item", () => {
    render(<SearchSettingsNav active="basics" onSelect={jest.fn()} />)
    // tavily is enabled+configured, brave is not → 1 of 10 providers.
    expect(screen.getByText("1/10")).toBeInTheDocument()
  })

  it("highlights the providers item and its badge when active", () => {
    render(<SearchSettingsNav active="providers" onSelect={jest.fn()} />)
    const providers = screen.getByText("nav.providers").closest("button")
    expect(providers).toHaveAttribute("aria-current", "page")
    expect(screen.getByText("1/10")).toBeInTheDocument()
  })

  it("calls onSelect with the clicked section id", () => {
    const onSelect = jest.fn()
    render(<SearchSettingsNav active="basics" onSelect={onSelect} />)
    fireEvent.click(screen.getByText("nav.providers"))
    expect(onSelect).toHaveBeenCalledWith("providers")
  })
})
