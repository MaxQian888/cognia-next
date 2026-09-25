import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count == null ? key : `${key}:${values.count}`,
}))
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

const availabilityMock = jest.fn()
const importMock = jest.fn()
const clearMock = jest.fn()
jest.mock("@/lib/browser/cookie-import", () => ({
  ...jest.requireActual("@/lib/browser/cookie-import"),
  CHROMIUM_BROWSERS: ["chrome", "edge", "brave", "chromium"],
  isChromeCookieImportAvailable: (...args: unknown[]) => availabilityMock(...args),
  importChromeCookies: (...args: unknown[]) => importMock(...args),
  clearSiteCookies: (...args: unknown[]) => clearMock(...args),
}))

let featureEnabled = true
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { browserCookieImportEnabled: featureEnabled } }),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

import { toast } from "sonner"
import { BrowserCookieImportAction } from "./browser-cookie-import-action"

const renderAction = (
  onReload = jest.fn().mockResolvedValue(undefined),
  currentUrl: string | null = "https://www.github.com/settings"
) => ({
  onReload,
  ...render(
    <TooltipProvider>
      <BrowserCookieImportAction currentUrl={currentUrl} onReload={onReload} />
    </TooltipProvider>
  ),
})

beforeEach(() => {
  window.localStorage.clear()
  featureEnabled = true
  jest.clearAllMocks()
  availabilityMock.mockImplementation(async (browser: string) => ({
    supported: true,
    profiles: browser === "chrome" ? ["Default", "Profile 1"] : [],
    reason: browser === "chrome" ? null : "no_profiles",
  }))
  importMock.mockResolvedValue({
    kind: "ok",
    injected: 2,
    names: ["session"],
    domains: [".github.com"],
  })
  clearMock.mockResolvedValue({ removed: 3, domain: "github.com" })
})

/** Wait for the probes to settle, then open the dialog. */
async function openDialog() {
  const trigger = screen.getByRole("button", { name: "action" })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
}

// Import needs the switch; clearing what an earlier import left behind must
// not. Turning the feature off is exactly when someone wants the sign-in gone.
it("explains import is switched off, links to Settings, and still offers clearing", async () => {
  featureEnabled = false
  renderAction()
  await openDialog()
  expect(availabilityMock).not.toHaveBeenCalled()
  expect(screen.getByTestId("browser-cookie-import-blocked")).toHaveTextContent(
    "reason.featureDisabled"
  )
  expect(screen.getByRole("link", { name: "openSettings" })).toHaveAttribute(
    "href",
    "/settings?section=desktop"
  )
  expect(screen.queryByRole("button", { name: "import" })).toBeNull()
  expect(screen.getByRole("button", { name: "clear.action" })).toBeEnabled()
})

it("requires local consent before importing and reloads after success", async () => {
  const { onReload } = renderAction()
  const trigger = screen.getByRole("button", { name: "action" })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  expect(screen.getByText("consent.description")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "consent.continue" }))
  expect(window.localStorage.getItem("cognia.browser.cookie-import-consent.v1")).toBe("1")
  expect(screen.getByRole("combobox", { name: "browserLabel" })).toHaveValue("chrome")
  expect(screen.getByRole("combobox", { name: "profileLabel" })).toHaveValue("Default")
  fireEvent.click(screen.getByRole("button", { name: "import" }))

  await waitFor(() =>
    expect(importMock).toHaveBeenCalledWith({
      browser: "chrome",
      profile: "Default",
      domain: "www.github.com",
      featureEnabled: true,
    })
  )
  expect(toast.success).toHaveBeenCalledWith("result.ok:2")
  expect(onReload).toHaveBeenCalled()
})

it("supports selecting another available browser and profile", async () => {
  window.localStorage.setItem("cognia.browser.cookie-import-consent.v1", "1")
  availabilityMock.mockImplementation(async (browser: string) => ({
    supported: true,
    profiles: browser === "brave" ? ["Profile 2"] : browser === "chrome" ? ["Default"] : [],
    reason: null,
  }))
  renderAction()
  const trigger = screen.getByRole("button", { name: "action" })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole("combobox", { name: "browserLabel" }), {
    target: { value: "brave" },
  })
  expect(screen.getByRole("combobox", { name: "profileLabel" })).toHaveValue("Profile 2")
  fireEvent.click(screen.getByRole("button", { name: "import" }))
  await waitFor(() =>
    expect(importMock).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: "brave",
        profile: "Profile 2",
      })
    )
  )
})

it("explains why import is unavailable on unsupported platforms", async () => {
  availabilityMock.mockResolvedValue({ supported: false, profiles: [], reason: "macos_only" })
  renderAction()
  await openDialog()
  await waitFor(() =>
    expect(screen.getByTestId("browser-cookie-import-blocked")).toHaveTextContent(
      "reason.unsupported"
    )
  )
  expect(screen.queryByRole("button", { name: "import" })).toBeNull()
})

it.each([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "https://service.local/path",
  "file:///tmp/page.html",
])("does not probe or import a non-public preview URL: %s", (url) => {
  renderAction(undefined, url)
  expect(screen.getByRole("button", { name: "action" })).toBeDisabled()
  expect(screen.getByText("reason.openPage")).toBeInTheDocument()
  expect(availabilityMock).not.toHaveBeenCalled()
})

it("settles failed availability probes instead of staying in checking state", async () => {
  availabilityMock.mockRejectedValue(new Error("transport unavailable"))
  renderAction()
  await openDialog()
  await waitFor(() => expect(screen.getByText("reason.checkFailed")).toBeInTheDocument())
  expect(screen.queryByText("reason.checking")).not.toBeInTheDocument()
})

it("shows a localized failure and does not reload when import is denied", async () => {
  window.localStorage.setItem("cognia.browser.cookie-import-consent.v1", "1")
  importMock.mockResolvedValue({ kind: "permission_denied" })
  const { onReload } = renderAction()
  const trigger = screen.getByRole("button", { name: "action" })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("button", { name: "import" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("result.permissionDenied"))
  expect(onReload).not.toHaveBeenCalled()
})

it("shows a generic localized error when the native import rejects", async () => {
  window.localStorage.setItem("cognia.browser.cookie-import-consent.v1", "1")
  importMock.mockRejectedValue(new Error("native failure"))
  const { onReload } = renderAction()
  const trigger = screen.getByRole("button", { name: "action" })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("button", { name: "import" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("result.failed"))
  expect(onReload).not.toHaveBeenCalled()
})

it("reports reload failure without also showing import success", async () => {
  window.localStorage.setItem("cognia.browser.cookie-import-consent.v1", "1")
  const onReload = jest.fn().mockRejectedValue(new Error("reload failed"))
  renderAction(onReload)
  const trigger = screen.getByRole("button", { name: "action" })
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("button", { name: "import" }))

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("result.failed"))
  expect(toast.success).not.toHaveBeenCalled()
})

// Working rule 7, UI half: cookie import reads this machine's Chromium keychain
// into this machine's WKWebView store, so a cloud Chromium can never use it.
// Disabled with the reason, not absent — an unexplained disappearance reads as
// a bug.
it("is inert with a stated reason on the cloud browser", () => {
  render(
    <TooltipProvider>
      <BrowserCookieImportAction
        backend="remote"
        currentUrl={null}
        onReload={() => Promise.resolve()}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole("button", { name: "action" })).toBeDisabled()
  // The reason is announced, not just implied by the disabled state.
  expect(screen.getByText("reason.remoteBackend")).toBeInTheDocument()
})

describe("signing out in the preview", () => {
  it("clears the current site's cookies, reloads, and says how many went", async () => {
    const { onReload } = renderAction()
    await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))

    await waitFor(() => expect(clearMock).toHaveBeenCalledWith("www.github.com"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("clear.done:3"))
    expect(onReload).toHaveBeenCalled()
  })

  it("does not reload when the preview held nothing for the site", async () => {
    clearMock.mockResolvedValue({ removed: 0, domain: "github.com" })
    const { onReload } = renderAction()
    await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("clear.none"))
    expect(onReload).not.toHaveBeenCalled()
  })

  it("reports a failed clear", async () => {
    clearMock.mockRejectedValue(new Error("store unavailable"))
    const { onReload } = renderAction()
    await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("clear.failed"))
    expect(onReload).not.toHaveBeenCalled()
  })

  // Consent covers reading another browser's credentials, not removing the
  // preview's own cookies.
  it("needs no consent to clear", async () => {
    renderAction()
    await openDialog()
    expect(screen.getByText("consent.description")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))
    await waitFor(() => expect(clearMock).toHaveBeenCalled())
  })
})
