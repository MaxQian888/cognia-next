import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULT_SEARCH_PROVIDER_SETTINGS } from "@cognia/web-search/types"
import { freshInstallWebReader } from "@/lib/web/reader/reader-settings"
import en from "@/i18n/messages/en/webReaderSettings.json"
import zh from "@/i18n/messages/zh-CN/webReaderSettings.json"
import { WebReaderSettings } from "./web-reader-settings"

jest.mock("next-intl", () => {
  const React = jest.requireActual("react") as typeof import("react")
  const Context = React.createContext<{ messages: Record<string, unknown>; locale: string }>({
    messages: {},
    locale: "en",
  })
  return {
    NextIntlClientProvider: ({
      messages,
      locale,
      children,
    }: {
      messages: Record<string, unknown>
      locale: string
      children: import("react").ReactNode
    }) => React.createElement(Context.Provider, { value: { messages, locale } }, children),
    useTranslations: (namespace: string) => {
      const { messages } = React.useContext(Context)
      return (key: string, values?: Record<string, unknown>) => {
        const template = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (node, segment) =>
              node && typeof node === "object"
                ? (node as Record<string, unknown>)[segment]
                : undefined,
            messages
          )
        if (typeof template !== "string")
          throw new Error(`Missing translation: ${namespace}.${key}`)
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
          String(values?.[name] ?? match)
        )
      }
    },
    useFormatter: () => {
      const { locale } = React.useContext(Context)
      return {
        dateTime: (value: number, options: Intl.DateTimeFormatOptions) =>
          new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(value),
      }
    },
  }
})

const mockNavigate = jest.fn()
const mockSetReader = jest.fn().mockResolvedValue(undefined)
const mockSetEntry = jest.fn().mockResolvedValue(undefined)
const mockSetDefault = jest.fn().mockResolvedValue(undefined)
const mockSetFallback = jest.fn().mockResolvedValue(undefined)
const mockSetDistillation = jest.fn().mockResolvedValue(undefined)
const mockTestReader = jest.fn()
let mockSettings: Partial<AppSettings>

jest.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    settings: mockSettings,
    setWebReader: mockSetReader,
    setWebReaderEntry: mockSetEntry,
    setWebReaderDefault: mockSetDefault,
    setWebReaderExternalFallback: mockSetFallback,
    setWebReaderDistillation: mockSetDistillation,
  }),
}))
jest.mock("./search-sections", () => ({ useSearchSectionNav: () => mockNavigate }))
const mockHostFetch = jest.fn()
jest.mock("@/lib/claude/plugin-tool-ipc", () => ({
  resolveWebToolDeps: async () => ({
    fetchImpl: mockHostFetch,
    hostReachable: { jina: false },
    allowPrivateHosts: false,
  }),
}))
jest.mock("@/lib/web/reader/reader-test", () => ({
  testReaderConnection: (...args: unknown[]) => mockTestReader(...args),
}))

function mount(locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ webReaderSettings: locale === "en" ? en : zh }}
    >
      <WebReaderSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = {
    webReader: freshInstallWebReader(),
    searchProviders: { ...DEFAULT_SEARCH_PROVIDER_SETTINGS },
  }
  mockTestReader.mockResolvedValue({ reader: "direct", ok: true, testedAt: Date.UTC(2026, 9, 19) })
})

it("shows all readers, recipients and opt-in fresh defaults without probing", () => {
  const { container } = mount()
  expect(container.querySelector('[data-setting-id="web-reader"]')).toBeInTheDocument()
  expect(screen.getAllByRole("switch")).toHaveLength(8)
  expect(screen.getByRole("switch", { name: "Direct" })).toBeChecked()
  expect(screen.getByRole("switch", { name: "Platform (WeChat / YouTube)" })).toBeChecked()
  expect(screen.getByRole("switch", { name: "Jina" })).not.toBeChecked()
  expect(screen.getByText("Fetched directly by Cognia")).toBeInTheDocument()
  expect(screen.getByText("Read from the original site")).toBeInTheDocument()
  expect(screen.getByText("Pages you read are sent to Jina")).toBeInTheDocument()
  expect(screen.getByLabelText("External fallback")).toHaveValue("off")
  expect(screen.getByLabelText("Distillation")).toHaveValue("off")
  expect(mockTestReader).not.toHaveBeenCalled()
  expect(mockSetReader).not.toHaveBeenCalled()
})

it("disables credentialed readers without a key and links to Search without duplicating secrets", () => {
  mount()
  expect(screen.getByRole("switch", { name: "Tavily" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Test reader: Tavily" })).toBeDisabled()
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("link", { name: "Add a Tavily key in Search providers" }))
  expect(mockNavigate).toHaveBeenCalledWith("providers", "search-provider-tavily")
})

it("reuses a disabled Search provider's key for independent Reader testing", async () => {
  mockSettings.searchProviders = {
    ...DEFAULT_SEARCH_PROVIDER_SETTINGS,
    tavily: { providerId: "tavily", apiKey: "tvly-test", enabled: false, priority: 1 },
  }
  mockTestReader.mockResolvedValue({
    reader: "tavily",
    ok: false,
    reason: "reader-unavailable",
    testedAt: Date.UTC(2026, 9, 19),
  })
  mount()
  expect(screen.getByText("Uses your Tavily search key")).toBeInTheDocument()
  expect(screen.getByRole("switch", { name: "Tavily" })).not.toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Test reader: Tavily" }))
  await waitFor(() => expect(screen.getByText(/Reader test failed/)).toBeInTheDocument())
  const deps = mockTestReader.mock.calls[0][1]
  expect(deps.credentialFor("tavily")).toBe("tvly-test")
  // The test uses the host transport and reachability real reads use.
  expect(deps.fetchImpl).toBe(mockHostFetch)
  expect(deps.hostReachable).toEqual({ jina: false })
  const status = screen.getByText(/Reason: reader-unavailable/).closest('[role="status"]')!
  expect(status).toHaveAttribute("aria-live", "polite")
  expect(within(status as HTMLElement).getByText(/Tested at/)).toHaveTextContent("2026")
})

it("saves enable, default, fallback and distillation independently without tests", async () => {
  mount()
  fireEvent.click(screen.getByRole("switch", { name: "Jina" }))
  await waitFor(() => expect(mockSetEntry).toHaveBeenCalledWith("jina", { enabled: true }))
  fireEvent.change(screen.getByLabelText("Default reader"), { target: { value: "direct" } })
  await waitFor(() => expect(mockSetDefault).toHaveBeenCalledWith("direct"))
  fireEvent.change(screen.getByLabelText("External fallback"), { target: { value: "configured" } })
  await waitFor(() => expect(mockSetFallback).toHaveBeenCalledWith("configured"))
  fireEvent.change(screen.getByLabelText("Distillation"), { target: { value: "required" } })
  await waitFor(() => expect(mockSetDistillation).toHaveBeenCalledWith("required"))
  expect(screen.getByText(en.consequences.required)).toBeInTheDocument()
  expect(mockTestReader).not.toHaveBeenCalled()
})

it("reorders with accessible buttons and preserves all enabled flags", async () => {
  mount()
  expect(screen.getByRole("button", { name: "Move Direct up" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Move Direct down" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Move Jina up" })).toBeDisabled()
  const down = screen.getByRole("button", { name: "Move Jina down" })
  down.focus()
  expect(down).toHaveFocus()
  fireEvent.click(down)
  await waitFor(() => expect(mockSetReader).toHaveBeenCalled())
  const saved = mockSetReader.mock.calls[0][0]
  expect(saved.readers.tavily).toEqual({ enabled: false, priority: 3 })
  expect(saved.readers.jina).toEqual({ enabled: false, priority: 4 })
  expect(saved.readers.jina.enabled).toBe(false)
})

it("preserves a future record until the user confirms replacement", async () => {
  mockSettings.webReader = { version: 99, future: "keep" }
  mount()
  expect(screen.getByRole("note")).toHaveTextContent("newer version and is inactive")
  expect(mockSetEntry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("switch", { name: "Jina" }))
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(mockSetEntry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("switch", { name: "Jina" }))
  fireEvent.click(screen.getByRole("button", { name: "Replace settings" }))
  await waitFor(() => expect(mockSetEntry).toHaveBeenCalledWith("jina", { enabled: false }))
  expect(mockTestReader).not.toHaveBeenCalled()
})

it("reports thrown test and save failures accessibly", async () => {
  mockTestReader.mockRejectedValue(new Error("offline"))
  mockSetEntry.mockRejectedValueOnce(new Error("save failed"))
  mount()
  fireEvent.click(screen.getByRole("button", { name: "Test reader: Direct" }))
  await waitFor(() => expect(screen.getByText(/Reader test failed/)).toBeInTheDocument())
  fireEvent.click(screen.getByRole("switch", { name: "Jina" }))
  await waitFor(() => expect(screen.getByText(en.saveFailed)).toBeInTheDocument())
})

it("loads the new namespace directly in both locales", () => {
  mount("zh-CN")
  expect(screen.getByLabelText("默认阅读器")).toBeInTheDocument()
  expect(screen.getByText("您阅读的页面会发送至 Jina")).toBeInTheDocument()
})

it.each([
  ["Default reader", "direct", mockSetDefault],
  ["External fallback", "off", mockSetFallback],
  ["Distillation", "required", mockSetDistillation],
] as const)(
  "keeps the chosen %s value through future-version confirmation",
  async (label, value, setter) => {
    mockSettings.webReader = { version: 99, future: "keep" }
    mount()
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    expect(setter).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Replace settings" }))
    await waitFor(() => expect(setter).toHaveBeenCalledWith(value))
  }
)
