/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import type { SearchProviderSettings, SearchProviderType } from "@/lib/search/types"

const setApiKeyMock = jest.fn(async (_id: string, _key: string) => undefined)
const setEnabledMock = jest.fn(async (_id: string, _v: boolean) => undefined)
const setSettingsMock = jest.fn(async (_id: string, _patch: unknown) => undefined)

const storeState: {
  settings: { searchProviders?: Partial<Record<SearchProviderType, SearchProviderSettings>> }
  setSearchProviderApiKey: typeof setApiKeyMock
  setSearchProviderEnabled: typeof setEnabledMock
  setSearchProviderSettings: typeof setSettingsMock
} = {
  settings: { searchProviders: {} },
  setSearchProviderApiKey: setApiKeyMock,
  setSearchProviderEnabled: setEnabledMock,
  setSearchProviderSettings: setSettingsMock,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { SearchProviderKeyList } from "./search-provider-key-list"

beforeEach(() => {
  setApiKeyMock.mockClear()
  setEnabledMock.mockClear()
  setSettingsMock.mockClear()
  storeState.settings = { searchProviders: {} }
})

describe("SearchProviderKeyList", () => {
  it("renders a row for every known provider", () => {
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("me-section-search-keys")).toBeInTheDocument()
    expect(screen.getByTestId("search-key-row-exa")).toBeInTheDocument()
    expect(screen.getByTestId("search-key-row-tavily")).toBeInTheDocument()
    expect(screen.getByTestId("search-key-row-google")).toBeInTheDocument()
  })

  it("persists a typed API key via the store action", () => {
    render(<SearchProviderKeyList />)
    fireEvent.change(screen.getByTestId("search-key-input-exa"), {
      target: { value: "exa-secret-123" },
    })
    expect(setApiKeyMock).toHaveBeenCalledWith("exa", "exa-secret-123")
  })

  it("reveals and hides the key field", () => {
    render(<SearchProviderKeyList />)
    const input = screen.getByTestId("search-key-input-exa") as HTMLInputElement
    expect(input.type).toBe("password")
    fireEvent.click(screen.getByTestId("search-key-reveal-exa"))
    expect((screen.getByTestId("search-key-input-exa") as HTMLInputElement).type).toBe("text")
  })

  it("disables the enable switch until a key is present", () => {
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-enabled-tavily")).toBeDisabled()
  })

  it("allows enabling once a key exists and toggles via the store", () => {
    storeState.settings = {
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "tvly-abc1234567890", enabled: false, priority: 1 },
      },
    }
    render(<SearchProviderKeyList />)
    const sw = screen.getByTestId("search-key-enabled-tavily")
    expect(sw).not.toBeDisabled()
    fireEvent.click(sw)
    expect(setEnabledMock).toHaveBeenCalledWith("tavily", true)
  })

  it("shows the invalid-format hint for a malformed key", () => {
    storeState.settings = {
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "nope", enabled: false, priority: 1 },
      },
    }
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-invalid-tavily")).toBeInTheDocument()
  })

  it("surfaces the Google cx field and persists it", () => {
    render(<SearchProviderKeyList />)
    const cx = screen.getByTestId("search-key-google-cx")
    fireEvent.change(cx, { target: { value: "012:abc" } })
    expect(setSettingsMock).toHaveBeenCalledWith("google", { cx: "012:abc" })
  })

  it("renders without a searchProviders map (defaults)", () => {
    storeState.settings = {}
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-input-exa")).toHaveValue("")
  })

  it("marks an enabled, configured provider as active", () => {
    storeState.settings = {
      searchProviders: {
        exa: { providerId: "exa", apiKey: "exa-abc1234567890", enabled: true, priority: 1 },
      },
    }
    render(<SearchProviderKeyList />)
    const row = screen.getByTestId("search-key-row-exa")
    expect(row).toHaveTextContent(/active/i)
  })

  it("enables the Google switch only when both key and cx are present", () => {
    storeState.settings = {
      searchProviders: {
        google: {
          providerId: "google",
          apiKey: "AIzaSomeKey1234567890",
          cx: "012:abc",
          enabled: false,
          priority: 1,
        },
      },
    }
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-enabled-google")).not.toBeDisabled()
  })

  it("handles a provider entry with an undefined apiKey", () => {
    storeState.settings = {
      searchProviders: {
        exa: { providerId: "exa", enabled: false, priority: 1 } as never,
      },
    }
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-input-exa")).toHaveValue("")
    expect(screen.getByTestId("search-key-enabled-exa")).toBeDisabled()
  })
})
