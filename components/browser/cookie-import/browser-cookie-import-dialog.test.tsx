import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    onClick,
  }: {
    href: string
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@/lib/platform/os", () => ({ isMacOs: jest.fn(() => true) }))
jest.mock("@/lib/browser/cookie-import", () => ({
  ...jest.requireActual("@/lib/browser/cookie-import"),
  listCookieSources: jest.fn(),
  listCookieDomains: jest.fn(),
  importCookiesV2: jest.fn(),
  openFullDiskAccessSettings: jest.fn(),
}))

let featureEnabled = true
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { browserCookieImportEnabled: featureEnabled } }),
}))

import { toast } from "sonner"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import {
  importCookiesV2,
  listCookieDomains,
  listCookieSources,
  openFullDiskAccessSettings,
  type CookieSource,
} from "@/lib/browser/cookie-import"
import { isMacOs } from "@/lib/platform/os"

import { BrowserCookieImportDialog, cookieSinkFor } from "./browser-cookie-import-dialog"

const copy = en.browserVault.cookieImport
const CONSENT_KEY = "cognia.browser.cookie-import-consent.v1"

const SOURCES: CookieSource[] = [
  {
    browser: "chrome",
    label: "Google Chrome",
    kind: "chromium",
    profiles: [
      { id: "Default", name: "Person 1" },
      { id: "Profile 2", name: "Work" },
    ],
    supported: true,
    reason: null,
  },
  {
    browser: "firefox",
    label: "Firefox",
    kind: "firefox",
    profiles: [{ id: "x.default", name: "default-release" }],
    supported: true,
    reason: null,
  },
  {
    browser: "safari",
    label: "Safari",
    kind: "safari",
    profiles: [],
    supported: false,
    reason: "full_disk_access_required",
  },
  {
    browser: "opera",
    label: "Opera",
    kind: "chromium",
    profiles: [],
    supported: false,
    reason: "not_installed",
  },
]

function renderDialog(
  props: Partial<{ backend: BrowserBackend; sessionId: string; currentHost: string | null }> = {}
) {
  const onOpenChange = jest.fn()
  const onImported = jest.fn()
  render(
    <BrowserCookieImportDialog
      open
      onOpenChange={onOpenChange}
      backend="embedded"
      currentHost="www.github.com"
      onImported={onImported}
      {...props}
    />
  )
  return { onOpenChange, onImported }
}

beforeEach(() => {
  jest.clearAllMocks()
  featureEnabled = true
  window.localStorage.setItem(CONSENT_KEY, "1")
  ;(listCookieSources as jest.Mock).mockResolvedValue(SOURCES)
  ;(listCookieDomains as jest.Mock).mockResolvedValue([
    { domain: "github.com", count: 4 },
    { domain: "google.com", count: 12 },
    { domain: "example.org", count: 1 },
  ])
  ;(importCookiesV2 as jest.Mock).mockResolvedValue({
    kind: "ok",
    injected: 3,
    skippedAppBound: 0,
    domains: ["github.com"],
  })
  ;(isMacOs as jest.Mock).mockReturnValue(true)
})

describe("cookieSinkFor", () => {
  it("routes each backend to its own cookie store", () => {
    expect(cookieSinkFor("embedded")).toBe("embedded")
    expect(cookieSinkFor("local-chromium")).toBe("local")
    expect(cookieSinkFor("user-chrome")).toBe("local")
    expect(cookieSinkFor("remote")).toBeNull()
    expect(cookieSinkFor("web-fallback")).toBeNull()
  })
})

// Rule 7, UI half: the cloud browser cannot receive this device's cookies.
it("is inert with a stated reason on the cloud browser", () => {
  renderDialog({ backend: "remote" })
  expect(screen.getByTestId("cookie-import-inert")).toHaveTextContent(copy.sink.unsupported)
  expect(listCookieSources).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: copy.import })).toBeNull()
})

it("points to Settings when the feature is off", async () => {
  const user = userEvent.setup()
  featureEnabled = false
  const { onOpenChange } = renderDialog()
  expect(screen.getByTestId("cookie-import-disabled")).toHaveTextContent(copy.featureDisabled)
  await user.click(screen.getByRole("link", { name: copy.openSettings }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(listCookieSources).not.toHaveBeenCalled()
})

it("asks for consent once before listing sources", async () => {
  const user = userEvent.setup()
  window.localStorage.clear()
  renderDialog()
  expect(screen.getByText(copy.consent.description)).toBeInTheDocument()
  expect(listCookieSources).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: copy.consent.continue }))
  expect(window.localStorage.getItem(CONSENT_KEY)).toBe("1")
  expect(await screen.findByRole("combobox", { name: copy.browser })).toHaveValue("chrome")
})

it("imports this site's cookies into the embedded preview", async () => {
  const user = userEvent.setup()
  const { onImported, onOpenChange } = renderDialog()
  const browser = await screen.findByRole("combobox", { name: copy.browser })
  expect(within(browser).getByRole("option", { name: "Opera (Not installed)" })).toBeDisabled()
  expect(screen.getByRole("combobox", { name: copy.profile })).toHaveValue("Default")
  expect(screen.getByRole("radio", { name: "This site (www.github.com)" })).toBeChecked()
  expect(screen.getByText(copy.sink.embedded)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: copy.import }))
  await waitFor(() =>
    expect(importCookiesV2).toHaveBeenCalledWith({
      browser: "chrome",
      profile: "Default",
      scope: { kind: "site", domain: "www.github.com" },
      sink: "embedded",
    })
  )
  expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok" }))
  expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Imported 3 cookie/))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("tells the user about App-Bound cookies it had to skip", async () => {
  const user = userEvent.setup()
  ;(importCookiesV2 as jest.Mock).mockResolvedValue({
    kind: "ok",
    injected: 1,
    skippedAppBound: 5,
    domains: [],
  })
  renderDialog()
  await user.click(await screen.findByRole("button", { name: copy.import }))
  await waitFor(() =>
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/App-Bound Encryption/))
  )
})

it("imports chosen domains, listed with counts and searchable", async () => {
  const user = userEvent.setup()
  renderDialog({ currentHost: null })
  await screen.findByRole("combobox", { name: copy.browser })
  expect(screen.getByRole("radio", { name: /This site/ })).toBeDisabled()
  expect(screen.getByRole("radio", { name: copy.domains })).toBeChecked()
  expect(await screen.findByLabelText("google.com")).toBeInTheDocument()
  expect(listCookieDomains).toHaveBeenCalledWith("chrome", "Default")
  const items = within(screen.getByRole("list", { name: copy.domains })).getAllByRole("listitem")
  expect(items[0]).toHaveTextContent("google.com")
  expect(screen.getByRole("button", { name: copy.import })).toBeDisabled()

  await user.type(screen.getByRole("searchbox", { name: copy.domainsSearch }), "git")
  expect(screen.queryByLabelText("google.com")).toBeNull()
  await user.click(screen.getByLabelText("github.com"))
  await user.clear(screen.getByRole("searchbox", { name: copy.domainsSearch }))
  await user.click(screen.getByLabelText("example.org"))
  await user.click(screen.getByRole("button", { name: copy.import }))
  await waitFor(() =>
    expect(importCookiesV2).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "domains", domains: ["github.com", "example.org"] },
      })
    )
  )
})

it("reloads domains for another profile and reports a failed listing", async () => {
  const user = userEvent.setup()
  ;(listCookieDomains as jest.Mock)
    .mockResolvedValueOnce([{ domain: "github.com", count: 4 }])
    .mockRejectedValueOnce(new Error("locked"))
  renderDialog({ currentHost: null })
  await screen.findByLabelText("github.com")
  await user.selectOptions(screen.getByRole("combobox", { name: copy.profile }), "Profile 2")
  expect(await screen.findByText(copy.domainsLoadFailed)).toBeInTheDocument()
  expect(listCookieDomains).toHaveBeenLastCalledWith("chrome", "Profile 2")
})

it("imports all cookies from another browser into a local session", async () => {
  const user = userEvent.setup()
  renderDialog({ backend: "local-chromium", sessionId: "s1" })
  await user.selectOptions(await screen.findByRole("combobox", { name: copy.browser }), "firefox")
  await user.click(screen.getByRole("radio", { name: copy.all }))
  expect(screen.getByText(copy.allHint)).toBeInTheDocument()
  expect(screen.getByText(copy.sink.local)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: copy.import }))
  await waitFor(() =>
    expect(importCookiesV2).toHaveBeenCalledWith({
      browser: "firefox",
      profile: "x.default",
      scope: { kind: "all" },
      sink: "local",
      sessionId: "s1",
    })
  )
})

it("needs a running local session for the local sink", async () => {
  renderDialog({ backend: "user-chrome" })
  await screen.findByRole("combobox", { name: copy.browser })
  expect(screen.getByText(copy.sink.localNoSession)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: copy.import })).toBeDisabled()
})

it("guides Safari users to Full Disk Access and opens the pane on macOS", async () => {
  const user = userEvent.setup()
  ;(openFullDiskAccessSettings as jest.Mock).mockResolvedValue(undefined)
  renderDialog()
  await user.selectOptions(await screen.findByRole("combobox", { name: copy.browser }), "safari")
  const guidance = screen.getByTestId("cookie-import-full-disk-access")
  expect(guidance).toHaveTextContent(copy.fullDiskAccess.description)
  expect(screen.getByRole("button", { name: copy.import })).toBeDisabled()
  await user.click(within(guidance).getByRole("button", { name: copy.fullDiskAccess.open }))
  expect(openFullDiskAccessSettings).toHaveBeenCalled()
})

it("reports when System Settings cannot be opened", async () => {
  const user = userEvent.setup()
  ;(openFullDiskAccessSettings as jest.Mock).mockRejectedValue(new Error("x"))
  renderDialog()
  await user.selectOptions(await screen.findByRole("combobox", { name: copy.browser }), "safari")
  await user.click(screen.getByRole("button", { name: copy.fullDiskAccess.open }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.fullDiskAccess.openFailed))
})

it("shows no open button when not on macOS", async () => {
  const user = userEvent.setup()
  ;(isMacOs as jest.Mock).mockReturnValue(false)
  renderDialog()
  await user.selectOptions(await screen.findByRole("combobox", { name: copy.browser }), "safari")
  expect(screen.getByTestId("cookie-import-full-disk-access")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: copy.fullDiskAccess.open })).toBeNull()
})

it.each([
  [{ kind: "permission_denied" }, copy.result.permissionDenied, false],
  [{ kind: "no_matching_cookies" }, copy.result.noMatchingCookies, false],
  [{ kind: "no_profile" }, copy.result.noProfile, false],
  [{ kind: "unsupported", reason: "x" }, copy.result.unsupported, false],
  [{ kind: "full_disk_access_required" }, copy.result.fullDiskAccessRequired, true],
])("explains a refused import %p in place", async (result, message, fda) => {
  const user = userEvent.setup()
  ;(importCookiesV2 as jest.Mock).mockResolvedValue(result)
  const { onOpenChange, onImported } = renderDialog()
  await user.click(await screen.findByRole("button", { name: copy.import }))
  expect(await screen.findByRole("alert")).toHaveTextContent(message)
  expect(Boolean(screen.queryByTestId("cookie-import-full-disk-access"))).toBe(fda)
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(onImported).not.toHaveBeenCalled()
})

it("reports a rejected import generically", async () => {
  const user = userEvent.setup()
  ;(importCookiesV2 as jest.Mock).mockRejectedValue(new Error("ipc"))
  renderDialog()
  await user.click(await screen.findByRole("button", { name: copy.import }))
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.result.failed)
})

it("reports when sources cannot be listed or none exist", async () => {
  ;(listCookieSources as jest.Mock).mockRejectedValueOnce(new Error("x"))
  const first = render(
    <BrowserCookieImportDialog open onOpenChange={jest.fn()} backend="embedded" />
  )
  expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument()
  first.unmount()
  ;(listCookieSources as jest.Mock).mockResolvedValueOnce([])
  renderDialog()
  expect(await screen.findByText(copy.noSources)).toBeInTheDocument()
})
