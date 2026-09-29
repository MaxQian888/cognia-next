import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { BrowserBackend } from "@/lib/browser/backend-availability"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count == null ? key : `${key}:${values.count}`,
}))

const clearMock = jest.fn()
jest.mock("@/lib/browser/cookie-import", () => ({
  ...jest.requireActual("@/lib/browser/cookie-import"),
  clearSiteCookies: (...args: unknown[]) => clearMock(...args),
}))
jest.mock("@/lib/browser/local-client", () => ({ localBrowser: { rpc: jest.fn() } }))

// The import flow itself is covered by the dialog's own suite; here we only
// pin what the action hands it.
jest.mock("@/components/browser/cookie-import/browser-cookie-import-dialog", () => ({
  BrowserCookieImportDialog: (props: {
    open: boolean
    backend: string
    sessionId?: string
    currentHost?: string | null
    onImported?: () => void
  }) =>
    props.open ? (
      <div
        data-testid="import-dialog"
        data-backend={props.backend}
        data-session={props.sessionId ?? ""}
        data-host={props.currentHost ?? ""}
      >
        <button type="button" onClick={() => props.onImported?.()}>
          imported
        </button>
      </div>
    ) : null,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

import { toast } from "sonner"
import { localBrowser } from "@/lib/browser/local-client"
import { BrowserCookieImportAction } from "./browser-cookie-import-action"

function renderAction({
  onReload = jest.fn().mockResolvedValue(undefined),
  currentUrl = "https://www.github.com/settings",
  backend,
  sessionId,
}: {
  onReload?: jest.Mock
  currentUrl?: string | null
  backend?: BrowserBackend
  sessionId?: string
} = {}) {
  render(
    <TooltipProvider>
      <BrowserCookieImportAction
        currentUrl={currentUrl}
        onReload={onReload}
        backend={backend}
        sessionId={sessionId}
      />
    </TooltipProvider>
  )
  return { onReload }
}

beforeEach(() => {
  jest.clearAllMocks()
  clearMock.mockResolvedValue({ removed: 3, domain: "github.com" })
})

function openDialog() {
  const trigger = screen.getByRole("button", { name: "action" })
  expect(trigger).toBeEnabled()
  fireEvent.click(trigger)
}

it("opens the import dialog for the current host and backend", () => {
  const { onReload } = renderAction({ backend: "local-chromium", sessionId: "s1" })
  openDialog()
  fireEvent.click(screen.getByRole("button", { name: "chooseImport" }))
  const dialog = screen.getByTestId("import-dialog")
  expect(dialog).toHaveAttribute("data-backend", "local-chromium")
  expect(dialog).toHaveAttribute("data-session", "s1")
  expect(dialog).toHaveAttribute("data-host", "www.github.com")
  // The action's own dialog steps aside for the import dialog.
  expect(screen.queryByRole("button", { name: "chooseImport" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "imported" }))
  expect(onReload).toHaveBeenCalled()
})

it.each([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "https://service.local/path",
  "file:///tmp/page.html",
])("is disabled on a non-public URL: %s", (url) => {
  renderAction({ currentUrl: url })
  expect(screen.getByRole("button", { name: "action" })).toBeDisabled()
  expect(screen.getByText("reason.openPage")).toBeInTheDocument()
})

// Working rule 7, UI half: the cloud browser and the web fallback run on
// another machine, so this device's cookies can never reach them. Disabled
// with the reason, not absent: an unexplained disappearance reads as a bug.
it.each(["remote", "web-fallback"] as const)("is inert with a stated reason on %s", (backend) => {
  renderAction({ backend, currentUrl: "https://www.github.com" })
  expect(screen.getByRole("button", { name: "action" })).toBeDisabled()
  expect(screen.getByText("reason.remoteBackend")).toBeInTheDocument()
})

describe("signing out in the embedded preview", () => {
  it("clears the current site's cookies, reloads, and says how many went", async () => {
    const { onReload } = renderAction()
    openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))
    await waitFor(() => expect(clearMock).toHaveBeenCalledWith("www.github.com"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("clear.done:3"))
    expect(onReload).toHaveBeenCalled()
  })

  it("does not reload when the preview held nothing for the site", async () => {
    clearMock.mockResolvedValue({ removed: 0, domain: "github.com" })
    const { onReload } = renderAction()
    openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("clear.none"))
    expect(onReload).not.toHaveBeenCalled()
  })

  it("reports a failed clear", async () => {
    clearMock.mockRejectedValue(new Error("store unavailable"))
    const { onReload } = renderAction()
    openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("clear.failed"))
    expect(onReload).not.toHaveBeenCalled()
  })
})

describe("signing out in local Chromium", () => {
  it("clears through the runtime and reloads", async () => {
    ;(localBrowser.rpc as jest.Mock).mockResolvedValue({ cleared: 2 })
    const { onReload } = renderAction({ backend: "local-chromium", sessionId: "s1" })
    openDialog()
    expect(screen.getByTestId("browser-cookie-clear-note")).toHaveTextContent(
      "localClearDescription"
    )
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))
    await waitFor(() =>
      expect(localBrowser.rpc).toHaveBeenCalledWith("browser.cookies.clear", {
        sessionId: "s1",
        domain: "www.github.com",
      })
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("clear.done:2"))
    expect(onReload).toHaveBeenCalled()
    expect(clearMock).not.toHaveBeenCalled()
  })

  it("confirms a clear whose count the runtime does not report", async () => {
    ;(localBrowser.rpc as jest.Mock).mockResolvedValue(null)
    renderAction({ backend: "local-chromium", sessionId: "s1" })
    openDialog()
    fireEvent.click(screen.getByRole("button", { name: "clear.action" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("localCleared"))
  })

  it("needs a running session", () => {
    renderAction({ backend: "local-chromium" })
    openDialog()
    expect(screen.getByTestId("browser-cookie-clear-note")).toHaveTextContent("localNoSession")
    expect(screen.getByRole("button", { name: "clear.action" })).toBeDisabled()
  })
})

it("leaves the user's own Chrome cookies to Chrome", () => {
  renderAction({ backend: "user-chrome", sessionId: "s1" })
  openDialog()
  expect(screen.getByTestId("browser-cookie-clear-note")).toHaveTextContent("userChromeClear")
  expect(screen.queryByRole("button", { name: "clear.action" })).toBeNull()
  expect(screen.getByRole("button", { name: "chooseImport" })).toBeEnabled()
})
