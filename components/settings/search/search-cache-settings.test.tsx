import { render, screen, fireEvent } from "@testing-library/react"

const setEnabledMock = jest.fn()
const setTTLMock = jest.fn()
const setMaxEntriesMock = jest.fn()

const cacheClearMock = jest.fn()
const cacheInvalidateMock = jest.fn()
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

jest.mock("@/lib/search/search-cache", () => ({
  getSearchCache: () => ({
    clear: cacheClearMock,
    invalidate: cacheInvalidateMock,
    setConfig: cacheSetConfigMock,
    getStats: cacheGetStatsMock,
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockLogInfo = jest.fn()
jest.mock("@/lib/logger", () => ({
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
  Slider: ({ value, onValueChange }: { value: number[]; onValueChange: (v: number[]) => void }) => (
    <input
      role="slider"
      type="number"
      aria-valuenow={value?.[0] ?? 0}
      value={value?.[0] ?? 0}
      onChange={(e) => onValueChange([Number(e.target.value)])}
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
  cacheInvalidateMock.mockReset()
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
