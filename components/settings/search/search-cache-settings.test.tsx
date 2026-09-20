import { render, screen, fireEvent } from "@testing-library/react"

const setEnabledMock = jest.fn()
const setTTLMock = jest.fn()
const setMaxEntriesMock = jest.fn()

const cacheClearMock = jest.fn()
const cacheInvalidateProviderMock = jest.fn()
const cacheSetConfigMock = jest.fn()
const cacheGetStatsMock = jest.fn()

let settings: {
  searchCacheEnabled?: boolean
  searchCacheTTL?: number
  searchCacheMaxEntries?: number
  searchProviders?: Record<string, unknown>
} = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: typeof settings
      setSearchCacheEnabled: typeof setEnabledMock
      setSearchCacheTTL: typeof setTTLMock
      setSearchCacheMaxEntries: typeof setMaxEntriesMock
    }) => T
  ) =>
    selector({
      settings,
      setSearchCacheEnabled: setEnabledMock,
      setSearchCacheTTL: setTTLMock,
      setSearchCacheMaxEntries: setMaxEntriesMock,
    }),
}))

jest.mock("@cognia/web-search/search-cache", () => ({
  getSearchCache: () => ({
    clear: cacheClearMock,
    invalidateProvider: cacheInvalidateProviderMock,
    setConfig: cacheSetConfigMock,
    getStats: cacheGetStatsMock,
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockLogInfo = jest.fn()
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }),
}))

jest.mock("@/components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    onValueCommit,
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    onValueCommit?: (v: number[]) => void
  }) => (
    <input
      role="slider"
      type="number"
      aria-valuenow={value?.[0] ?? 0}
      value={value?.[0] ?? 0}
      onChange={(e) => onValueChange([Number(e.target.value)])}
      onBlur={(e) => onValueCommit?.([Number(e.target.value)])}
    />
  ),
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
    <select
      data-testid="provider-select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
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

import { SearchCacheSettings } from "./search-cache-settings"

beforeEach(() => {
  setEnabledMock.mockReset()
  setTTLMock.mockReset()
  setMaxEntriesMock.mockReset()
  cacheClearMock.mockReset()
  cacheInvalidateProviderMock.mockReset()
  cacheSetConfigMock.mockReset()
  cacheGetStatsMock.mockReset().mockReturnValue({
    size: 5,
    maxSize: 100,
    hits: 3,
    misses: 1,
    hitRate: 0.75,
  })
  mockLogInfo.mockReset()
  settings = {}
})

describe("SearchCacheSettings", () => {
  it("renders title", () => {
    render(<SearchCacheSettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("hides config when disabled", () => {
    settings = { searchCacheEnabled: false }
    render(<SearchCacheSettings />)
    expect(screen.queryByText(/ttl/)).not.toBeInTheDocument()
  })

  it("renders cache stats when enabled", () => {
    settings = { searchCacheEnabled: true, searchCacheTTL: 600_000, searchCacheMaxEntries: 100 }
    render(<SearchCacheSettings />)
    expect(screen.getByText("75%")).toBeInTheDocument()
    expect(screen.getByText(/5\/100/)).toBeInTheDocument()
  })

  it("toggles cache enabled state", () => {
    settings = { searchCacheEnabled: true }
    render(<SearchCacheSettings />)
    fireEvent.click(screen.getByRole("switch"))
    expect(setEnabledMock).toHaveBeenCalledWith(false)
  })

  it("clear cache calls clear() when 'all' selected", () => {
    settings = { searchCacheEnabled: true }
    render(<SearchCacheSettings />)
    fireEvent.click(screen.getByText("clearCache"))
    expect(cacheClearMock).toHaveBeenCalled()
  })

  it("refresh button re-reads the cache stats", () => {
    settings = { searchCacheEnabled: true }
    render(<SearchCacheSettings />)
    cacheGetStatsMock.mockReturnValue({ size: 9, maxSize: 100, hits: 8, misses: 0, hitRate: 1 })
    fireEvent.click(screen.getByLabelText("refresh"))
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(screen.getByText(/9\/100/)).toBeInTheDocument()
  })

  it("provider select shows catalog names, not raw ids", () => {
    settings = {
      searchCacheEnabled: true,
      searchProviders: { tavily: { providerId: "tavily", enabled: true } },
    }
    render(<SearchCacheSettings />)
    expect(screen.getByText("Tavily")).toBeInTheDocument()
  })

  it("clears only entries owned by the selected provider", () => {
    settings = {
      searchCacheEnabled: true,
      searchProviders: { tavily: { providerId: "tavily", enabled: true } },
    }
    render(<SearchCacheSettings />)
    fireEvent.change(screen.getByTestId("provider-select"), { target: { value: "tavily" } })
    fireEvent.click(screen.getByText("clearCache"))
    expect(cacheInvalidateProviderMock).toHaveBeenCalledWith("tavily")
    expect(cacheClearMock).not.toHaveBeenCalled()
  })

  it("slider changes persist TTL and max entries and reconfigure the cache", () => {
    settings = { searchCacheEnabled: true }
    render(<SearchCacheSettings />)
    const sliders = screen.getAllByRole("slider")
    fireEvent.change(sliders[0], { target: { value: "120000" } })
    expect(setTTLMock).toHaveBeenCalledWith(120000)
    expect(cacheSetConfigMock).toHaveBeenCalledWith({ defaultTTL: 120000 })
    fireEvent.blur(sliders[0], { target: { value: "120000" } })
    expect(mockLogInfo).toHaveBeenCalledWith("cache_ttl_changed", { ttlMs: 120000 })
    fireEvent.change(sliders[1], { target: { value: "800" } })
    expect(setMaxEntriesMock).toHaveBeenCalledWith(800)
    expect(cacheSetConfigMock).toHaveBeenCalledWith({ maxSize: 800 })
    fireEvent.blur(sliders[1], { target: { value: "800" } })
    expect(mockLogInfo).toHaveBeenCalledWith("cache_max_entries_changed", {
      maxEntries: 800,
    })
  })

  it("logs cache_enabled_changed when toggled", () => {
    settings = { searchCacheEnabled: true }
    render(<SearchCacheSettings />)
    fireEvent.click(screen.getByRole("switch"))
    expect(mockLogInfo).toHaveBeenCalledWith("cache_enabled_changed", { enabled: false })
  })

  it("logs cache_cleared with sizeBefore", () => {
    settings = { searchCacheEnabled: true }
    render(<SearchCacheSettings />)
    fireEvent.click(screen.getByText("clearCache"))
    expect(mockLogInfo).toHaveBeenCalledWith(
      "cache_cleared",
      expect.objectContaining({ provider: "all", sizeBefore: 5 })
    )
  })
})
