import { render, screen, fireEvent } from "@testing-library/react"

const mocks = {
  setDefaultSearchType: jest.fn(),
  setDefaultSearchDepth: jest.fn(),
  setDefaultSearchRecency: jest.fn(),
  setDefaultSearchCountry: jest.fn(),
  setDefaultSearchLanguage: jest.fn(),
  setDefaultIncludeDomains: jest.fn(),
  setDefaultExcludeDomains: jest.fn(),
  setDefaultIncludeAnswer: jest.fn(),
  setDefaultIncludeRawContent: jest.fn(),
}

let settings: Record<string, unknown> = {}

jest.mock("@/stores/settings-store", () => ({
  useSettingsStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({ settings, ...mocks }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: () => null,
}))

import { SearchDefaultsSettings } from "./search-defaults-settings"

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset())
  settings = {}
})

describe("SearchDefaultsSettings", () => {
  it("renders title", () => {
    render(<SearchDefaultsSettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("renders all search type buttons", () => {
    render(<SearchDefaultsSettings />)
    expect(screen.getByText("general")).toBeInTheDocument()
    expect(screen.getByText("news")).toBeInTheDocument()
    expect(screen.getByText("academic")).toBeInTheDocument()
  })

  it("changes search type on click", () => {
    render(<SearchDefaultsSettings />)
    fireEvent.click(screen.getByText("news"))
    expect(mocks.setDefaultSearchType).toHaveBeenCalledWith("news")
  })

  it("changes search depth on click", () => {
    render(<SearchDefaultsSettings />)
    fireEvent.click(screen.getByText("advanced"))
    expect(mocks.setDefaultSearchDepth).toHaveBeenCalledWith("advanced")
  })

  it("toggles includeAnswer switch", () => {
    settings = { defaultIncludeAnswer: false }
    render(<SearchDefaultsSettings />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[0])
    expect(mocks.setDefaultIncludeAnswer).toHaveBeenCalledWith(true)
  })

  it("adds include domain on Enter key", () => {
    render(<SearchDefaultsSettings />)
    const inputs = screen.getAllByPlaceholderText(/Placeholder|placeholder/)
    const includeInput = inputs.find((i) =>
      (i as HTMLInputElement).placeholder.includes("includeDomainsPlaceholder")
    )!
    fireEvent.change(includeInput, { target: { value: "example.com" } })
    fireEvent.keyDown(includeInput, { key: "Enter" })
    expect(mocks.setDefaultIncludeDomains).toHaveBeenCalledWith(["example.com"])
  })

  it("removes a domain when X clicked", () => {
    settings = { defaultIncludeDomains: ["a.com"] }
    render(<SearchDefaultsSettings />)
    const removeBtn = screen.getByText("a.com").parentElement?.querySelector("button")
    if (removeBtn) fireEvent.click(removeBtn)
    expect(mocks.setDefaultIncludeDomains).toHaveBeenCalledWith([])
  })

  it("changes country and language", () => {
    render(<SearchDefaultsSettings />)
    const country = screen.getByPlaceholderText("countryPlaceholder")
    fireEvent.change(country, { target: { value: "us" } })
    expect(mocks.setDefaultSearchCountry).toHaveBeenCalledWith("us")
    const lang = screen.getByPlaceholderText("languagePlaceholder")
    fireEvent.change(lang, { target: { value: "fr" } })
    expect(mocks.setDefaultSearchLanguage).toHaveBeenCalledWith("fr")
  })

  it("ignores duplicate domain additions", () => {
    settings = { defaultIncludeDomains: ["a.com"] }
    render(<SearchDefaultsSettings />)
    const inputs = screen.getAllByPlaceholderText(/Placeholder|placeholder/)
    const includeInput = inputs.find((i) =>
      (i as HTMLInputElement).placeholder.includes("includeDomainsPlaceholder")
    )!
    fireEvent.change(includeInput, { target: { value: "a.com" } })
    fireEvent.keyDown(includeInput, { key: "Enter" })
    expect(mocks.setDefaultIncludeDomains).not.toHaveBeenCalled()
  })

  it("adds exclude domain on Enter and removes on X click", () => {
    settings = { defaultExcludeDomains: ["bad.com"] }
    render(<SearchDefaultsSettings />)
    const inputs = screen.getAllByPlaceholderText(/Placeholder|placeholder/)
    const excludeInput = inputs.find((i) =>
      (i as HTMLInputElement).placeholder.includes("excludeDomainsPlaceholder")
    )!
    fireEvent.change(excludeInput, { target: { value: "newbad.com" } })
    fireEvent.keyDown(excludeInput, { key: "Enter" })
    expect(mocks.setDefaultExcludeDomains).toHaveBeenCalledWith(["bad.com", "newbad.com"])

    const removeBtn = screen.getByText("bad.com").parentElement?.querySelector("button")
    if (removeBtn) fireEvent.click(removeBtn)
    expect(mocks.setDefaultExcludeDomains).toHaveBeenCalledWith([])
  })
})
