/**
 * @jest-environment jsdom
 */
import { fireEvent, render as renderUI, screen, within } from "@testing-library/react"
import type { ReactElement } from "react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import mobileMe from "@/i18n/messages/en/mobile/me.json"

import {
  SEARCH_PROVIDERS,
  type SearchProviderSettings,
  type SearchProviderType,
} from "@cognia/web-search/types"

jest.mock("next-intl", () => {
  const React = jest.requireActual("react") as typeof import("react")
  const Context = React.createContext<Record<string, unknown>>({})
  return {
    NextIntlClientProvider: ({
      messages,
      children,
    }: {
      messages: Record<string, unknown>
      children: import("react").ReactNode
    }) => React.createElement(Context.Provider, { value: messages }, children),
    useTranslations: (namespace: string) => {
      const messages = React.useContext(Context)
      return (key: string, values?: Record<string, unknown>) => {
        const value = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (node, segment) =>
              node && typeof node === "object"
                ? (node as Record<string, unknown>)[segment]
                : undefined,
            messages
          )
        const template = typeof value === "string" ? value : key
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
          String(values?.[name] ?? match)
        )
      }
    },
  }
})

function render(ui: ReactElement) {
  return renderUI(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...messages, mobile: { ...messages.mobile, me: mobileMe } }}
    >
      {ui}
    </NextIntlClientProvider>
  )
}

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
    for (const id of Object.keys(SEARCH_PROVIDERS)) {
      expect(screen.getByTestId(`search-key-row-${id}`)).toBeInTheDocument()
    }
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

  it("keeps retired Bing inert and preserves its stored key", () => {
    storeState.settings = {
      searchProviders: {
        bing: { providerId: "bing", apiKey: "saved-bing-secret", enabled: true, priority: 1 },
      },
    }
    render(<SearchProviderKeyList />)
    const row = screen.getByTestId("search-key-row-bing")
    expect(row).toHaveTextContent("Retired on 2025-08-11")
    expect(within(row).queryByRole("switch")).not.toBeInTheDocument()
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument()
    expect(storeState.settings.searchProviders?.bing?.apiKey).toBe("saved-bing-secret")
    expect(setApiKeyMock).not.toHaveBeenCalled()
    expect(setEnabledMock).not.toHaveBeenCalled()
    expect(setSettingsMock).not.toHaveBeenCalled()
  })

  it("shows the Google legacy deadline", () => {
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-row-google")).toHaveTextContent("service ends 2027-01-01")
  })

  it.each(["deepseek", "tinyfish"] as const)("persists the %s search key", (id) => {
    render(<SearchProviderKeyList />)
    fireEvent.change(screen.getByTestId(`search-key-input-${id}`), {
      target: { value: "new-vendor-key" },
    })
    expect(setApiKeyMock).toHaveBeenCalledWith(id, "new-vendor-key")
  })

  it("configures SearXNG by endpoint without a key field", () => {
    render(<SearchProviderKeyList />)
    expect(screen.queryByTestId("search-key-input-searxng")).not.toBeInTheDocument()
    expect(screen.getByTestId("search-key-enabled-searxng")).toBeDisabled()
    fireEvent.change(screen.getByRole("textbox", { name: "SearXNG endpoint URL" }), {
      target: { value: "https://search.example.org" },
    })
    expect(setSettingsMock).toHaveBeenCalledWith("searxng", {
      baseUrl: "https://search.example.org",
    })
    expect(setApiKeyMock).not.toHaveBeenCalled()
  })

  it("allows a public HTTPS endpoint without a key or private grant", () => {
    storeState.settings = {
      searchProviders: {
        searxng: {
          providerId: "searxng",
          apiKey: "",
          baseUrl: "https://search.example.org",
          enabled: false,
          priority: 1,
        },
      },
    }
    render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-enabled-searxng")).not.toBeDisabled()
    expect(screen.queryByTestId("search-endpoint-private-searxng")).not.toBeInTheDocument()
  })

  it("requires an explicit grant for private HTTP endpoints", () => {
    storeState.settings = {
      searchProviders: {
        searxng: {
          providerId: "searxng",
          apiKey: "",
          baseUrl: "http://localhost:8888",
          enabled: false,
          priority: 1,
        },
      },
    }
    const { rerender } = render(<SearchProviderKeyList />)
    expect(screen.getByTestId("search-key-enabled-searxng")).toBeDisabled()
    fireEvent.click(screen.getByRole("switch", { name: "Allow private / HTTP endpoint" }))
    expect(setSettingsMock).toHaveBeenCalledWith("searxng", { allowPrivateEndpoint: true })
    storeState.settings.searchProviders!.searxng!.allowPrivateEndpoint = true
    rerender(
      <NextIntlClientProvider
        locale="en"
        timeZone="UTC"
        messages={{ ...messages, mobile: { ...messages.mobile, me: mobileMe } }}
      >
        <SearchProviderKeyList />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("search-key-enabled-searxng")).not.toBeDisabled()
  })

  it.each([
    ["http://search.example.org", "Public endpoints must use HTTPS."],
    [
      "https://user:secret@search.example.org",
      "Remove embedded credentials from the endpoint URL.",
    ],
    [
      "https://search.example.org?format=json",
      "Remove query parameters and fragments from the endpoint URL.",
    ],
  ])("shows an accessible validation error for %s", (baseUrl, error) => {
    storeState.settings = {
      searchProviders: {
        searxng: { providerId: "searxng", apiKey: "", baseUrl, enabled: false, priority: 1 },
      },
    }
    render(<SearchProviderKeyList />)
    expect(screen.getByRole("status")).toHaveTextContent(error)
    expect(screen.getByTestId("search-key-enabled-searxng")).toBeDisabled()
    expect(screen.getByTestId("search-endpoint-input-searxng")).toHaveAttribute(
      "aria-invalid",
      "true"
    )
    expect(screen.queryByTestId("search-endpoint-private-searxng")).not.toBeInTheDocument()
  })
})
