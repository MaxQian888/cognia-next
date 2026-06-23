import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./search-global-settings", () => ({
  SearchGlobalSettings: ({ onConfigureProviders }: { onConfigureProviders?: () => void }) => (
    <button onClick={onConfigureProviders}>basics-cfg</button>
  ),
}))
jest.mock("./search-defaults-settings", () => ({
  SearchDefaultsSettings: () => <div data-testid="leaf-defaults" />,
}))
jest.mock("./search-cache-settings", () => ({
  SearchCacheSettings: () => <div data-testid="leaf-cache" />,
}))
jest.mock("./search-safety-settings", () => ({
  SearchSafetySettings: () => <div data-testid="leaf-safety" />,
}))
jest.mock("./source-verification-settings", () => ({
  SourceVerificationSettings: () => <div data-testid="leaf-verification" />,
}))
jest.mock("./search-provider-grid", () => ({
  SearchProviderGrid: () => <div data-testid="leaf-grid" />,
}))
jest.mock("./search-provider-compare", () => ({
  SearchProviderCompare: () => <div data-testid="leaf-compare" />,
}))
jest.mock("./search-usage-panel", () => ({
  SearchUsagePanel: () => <div data-testid="leaf-usage" />,
}))

import {
  SEARCH_SECTIONS,
  SEARCH_SECTION_PARAM,
  isSearchSection,
  SearchSectionNavProvider,
} from "./search-sections"

describe("search-sections config", () => {
  it("exposes the deep-link param name", () => {
    expect(SEARCH_SECTION_PARAM).toBe("searchSection")
  })

  it("defines six sections with unique ids", () => {
    expect(SEARCH_SECTIONS).toHaveLength(6)
    const ids = SEARCH_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(6)
    expect(ids).toEqual(["basics", "providers", "behavior", "safety", "performance", "diagnostics"])
  })

  it("guards valid and invalid section ids", () => {
    expect(isSearchSection("providers")).toBe(true)
    expect(isSearchSection("nope")).toBe(false)
    expect(isSearchSection(null)).toBe(false)
  })

  it("renders the providers section to the grid leaf", () => {
    const Providers = SEARCH_SECTIONS.find((s) => s.id === "providers")!.Component
    render(<Providers />)
    expect(screen.getByTestId("leaf-grid")).toBeInTheDocument()
  })

  it("composes safety from safe-search and source verification", () => {
    const Safety = SEARCH_SECTIONS.find((s) => s.id === "safety")!.Component
    render(<Safety />)
    expect(screen.getByTestId("leaf-safety")).toBeInTheDocument()
    expect(screen.getByTestId("leaf-verification")).toBeInTheDocument()
  })

  it("composes diagnostics from usage and compare", () => {
    const Diagnostics = SEARCH_SECTIONS.find((s) => s.id === "diagnostics")!.Component
    render(<Diagnostics />)
    expect(screen.getByTestId("leaf-usage")).toBeInTheDocument()
    expect(screen.getByTestId("leaf-compare")).toBeInTheDocument()
  })

  it("wires the basics empty-state to navigate to providers", () => {
    const navigate = jest.fn()
    const Basics = SEARCH_SECTIONS.find((s) => s.id === "basics")!.Component
    render(
      <SearchSectionNavProvider navigate={navigate}>
        <Basics />
      </SearchSectionNavProvider>
    )
    fireEvent.click(screen.getByText("basics-cfg"))
    expect(navigate).toHaveBeenCalledWith("providers")
  })
})
