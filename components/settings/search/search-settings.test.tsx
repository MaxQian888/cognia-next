import { render, screen, fireEvent } from "@testing-library/react"

const mockReplace = jest.fn()
let mockSearch = ""
let mockNarrow = false

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

jest.mock("@/hooks/ui/use-media-query", () => ({
  useIsNarrow: () => mockNarrow,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./search-settings-nav", () => ({
  SearchSettingsNav: ({ active, onSelect }: { active: string; onSelect: (id: string) => void }) => (
    <div data-testid="nav" data-active={active}>
      <button onClick={() => onSelect("providers")}>go-providers</button>
    </div>
  ),
}))

jest.mock("@/components/ui/accordion", () => ({
  Accordion: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode
    onValueChange?: (v: string) => void
  }) => (
    <div data-testid="accordion">
      <button onClick={() => onValueChange?.("safety")}>acc-go-safety</button>
      <button onClick={() => onValueChange?.("")}>acc-collapse</button>
      {children}
    </div>
  ),
  AccordionItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  AccordionTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("./search-sections", () => {
  const ids = ["basics", "providers", "behavior", "safety", "performance", "diagnostics"]
  return {
    SEARCH_SECTION_PARAM: "searchSection",
    isSearchSection: (v: string | null | undefined) => !!v && ids.includes(v),
    SearchSectionNavProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SEARCH_SECTIONS: ids.map((id) => ({
      id,
      labelKey: `nav.${id}`,
      descKey: `nav.${id}Desc`,
      icon: null,
      Component: () => <div data-testid={`sec-${id}`} />,
    })),
  }
})

import { SearchSettings } from "./search-settings"

beforeEach(() => {
  mockReplace.mockReset()
  mockSearch = ""
  mockNarrow = false
})

describe("SearchSettings (two-pane shell)", () => {
  it("renders the page header", () => {
    render(<SearchSettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("description")).toBeInTheDocument()
  })

  it("defaults to the basics section on desktop", () => {
    render(<SearchSettings />)
    expect(screen.getByTestId("nav")).toHaveAttribute("data-active", "basics")
    expect(screen.getByTestId("sec-basics")).toBeInTheDocument()
    expect(screen.getByText("nav.basics")).toBeInTheDocument()
    expect(screen.getByText("nav.basicsDesc")).toBeInTheDocument()
  })

  it("honors the deep-linked section from the URL param", () => {
    mockSearch = "searchSection=behavior"
    render(<SearchSettings />)
    expect(screen.getByTestId("sec-behavior")).toBeInTheDocument()
    expect(screen.queryByTestId("sec-basics")).not.toBeInTheDocument()
  })

  it("falls back to basics for an invalid section param", () => {
    mockSearch = "searchSection=bogus"
    render(<SearchSettings />)
    expect(screen.getByTestId("sec-basics")).toBeInTheDocument()
  })

  it("navigates by updating the searchSection URL param", () => {
    render(<SearchSettings />)
    fireEvent.click(screen.getByText("go-providers"))
    expect(mockReplace).toHaveBeenCalledWith("?searchSection=providers", { scroll: false })
  })

  it("renders the accordion fallback on narrow screens", () => {
    mockNarrow = true
    render(<SearchSettings />)
    expect(screen.getByTestId("accordion")).toBeInTheDocument()
    // Every section is reachable as an accordion item.
    expect(screen.getByText("nav.diagnostics")).toBeInTheDocument()
    // The desktop rail is not rendered on narrow screens.
    expect(screen.queryByTestId("nav")).not.toBeInTheDocument()
  })

  it("navigates when an accordion section is opened", () => {
    mockNarrow = true
    render(<SearchSettings />)
    fireEvent.click(screen.getByText("acc-go-safety"))
    expect(mockReplace).toHaveBeenCalledWith("?searchSection=safety", { scroll: false })
  })

  it("ignores accordion collapse (empty value) without navigating", () => {
    mockNarrow = true
    render(<SearchSettings />)
    fireEvent.click(screen.getByText("acc-collapse"))
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
