import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn(), save: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@/lib/browser/extensions-client", () => ({
  ...jest.requireActual("@/lib/browser/extensions-client"),
  listExtensions: jest.fn(),
  prepareWebStoreExtension: jest.fn(),
  pickCrxExtension: jest.fn(),
  pickUnpackedExtension: jest.fn(),
  confirmExtensionInstall: jest.fn(),
  cancelExtensionInstall: jest.fn(),
  setExtensionEnabled: jest.fn(),
  removeExtension: jest.fn(),
  checkExtensionUpdates: jest.fn(),
  updateExtension: jest.fn(),
}))
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: { rpc: jest.fn(), onEvent: jest.fn() },
}))

import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import {
  cancelExtensionInstall,
  checkExtensionUpdates,
  confirmExtensionInstall,
  listExtensions,
  pickCrxExtension,
  pickUnpackedExtension,
  prepareWebStoreExtension,
  removeExtension,
  setExtensionEnabled,
  updateExtension,
  type BrowserExtension,
  type PendingExtensionInstall,
} from "@/lib/browser/extensions-client"
import { localBrowser } from "@/lib/browser/local-client"
import type { BrowserBackend } from "@/lib/browser/backend-availability"

import { BrowserExtensionsPanel, extensionsInertReason } from "./browser-extensions-panel"

const vault = en.browserVault.extensions

function extension(overrides: Partial<BrowserExtension> = {}): BrowserExtension {
  return {
    id: "abcdefghijklmnopabcdefghijklmnop",
    name: "uBlock Origin Lite",
    version: "1.0.0",
    enabled: true,
    source: "webstore",
    installedAt: 1,
    permissions: ["storage", "declarativeNetRequest"],
    hostPermissions: ["<all_urls>"],
    iconPath: null,
    popupPath: "popup.html",
    optionsPath: "options.html",
    description: "Blocks ads",
    ...overrides,
  }
}

function pending(overrides: Partial<PendingExtensionInstall> = {}): PendingExtensionInstall {
  return {
    pendingId: "p1",
    id: "x".repeat(32),
    name: "Dark Reader",
    version: "4.9",
    description: null,
    permissions: ["storage", "tabs"],
    hostPermissions: ["<all_urls>"],
    source: "webstore",
    ...overrides,
  }
}

let eventHandler: ((event: unknown) => void) | null = null
const unlisten = jest.fn()

function renderPanel(backend: BrowserBackend = "local-chromium", sessionId?: string) {
  // jest.setup mocks next-intl against the real en.json (plural `one` renders
  // as `other`, so plural assertions match on the stem).
  return render(<BrowserExtensionsPanel backend={backend} sessionId={sessionId} />)
}

beforeEach(() => {
  jest.clearAllMocks()
  eventHandler = null
  ;(listExtensions as jest.Mock).mockResolvedValue([extension()])
  ;(cancelExtensionInstall as jest.Mock).mockResolvedValue(undefined)
  ;(localBrowser.onEvent as jest.Mock).mockImplementation(async (cb: (e: unknown) => void) => {
    eventHandler = cb
    return unlisten
  })
})

describe("extensionsInertReason", () => {
  it("is live only on local Chromium", () => {
    expect(extensionsInertReason("local-chromium")).toBeNull()
    expect(extensionsInertReason("embedded")).toBe("embedded")
    expect(extensionsInertReason("user-chrome")).toBe("userChrome")
    expect(extensionsInertReason("remote")).toBe("remote")
    expect(extensionsInertReason("web-fallback")).toBe("remote")
  })
})

it("lists installed extensions with source, permissions and version", async () => {
  renderPanel()
  expect(await screen.findByText("uBlock Origin Lite")).toBeInTheDocument()
  expect(screen.getByText("Version 1.0.0")).toBeInTheDocument()
  expect(screen.getByText("Web Store")).toBeInTheDocument()
  expect(screen.getByText("2 permissions")).toBeInTheDocument()
  expect(screen.getByText(/^1 site/)).toBeInTheDocument()
})

it("shows a Web Store extension's permissions and installs only after confirmation", async () => {
  const user = userEvent.setup()
  ;(prepareWebStoreExtension as jest.Mock).mockResolvedValue(pending())
  ;(confirmExtensionInstall as jest.Mock).mockResolvedValue(
    extension({ id: "x".repeat(32), name: "Dark Reader" })
  )
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  const field = screen.getByRole("textbox", { name: vault.install.label })
  await user.type(field, "https://chromewebstore.google.com/detail/x")
  await user.click(screen.getByRole("button", { name: vault.install.webstore }))
  await waitFor(() =>
    expect(prepareWebStoreExtension).toHaveBeenCalledWith(
      "https://chromewebstore.google.com/detail/x"
    )
  )
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog).toHaveTextContent("Install Dark Reader?")
  const permissions = within(dialog).getByRole("list", { name: vault.installConfirm.permissions })
  expect(within(permissions).getByText("storage")).toBeInTheDocument()
  expect(within(permissions).getByText("tabs")).toBeInTheDocument()
  const hosts = within(dialog).getByRole("list", { name: vault.installConfirm.hostPermissions })
  expect(within(hosts).getByText(vault.installConfirm.allSites)).toBeInTheDocument()
  expect(confirmExtensionInstall).not.toHaveBeenCalled()

  await user.click(within(dialog).getByRole("button", { name: vault.installConfirm.confirm }))
  await waitFor(() => expect(confirmExtensionInstall).toHaveBeenCalledWith("p1"))
  expect(await screen.findByText("Dark Reader")).toBeInTheDocument()
  expect(toast.success).toHaveBeenCalledWith("Installed Dark Reader.")
  expect(field).toHaveValue("")
})

it("declining the confirmation installs nothing and drops the pending package", async () => {
  const user = userEvent.setup()
  ;(prepareWebStoreExtension as jest.Mock).mockResolvedValue(pending({ pendingId: "p9" }))
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  await user.type(screen.getByRole("textbox", { name: vault.install.label }), "abc")
  await user.click(screen.getByRole("button", { name: vault.install.webstore }))
  const dialog = await screen.findByRole("alertdialog")
  await user.click(within(dialog).getByRole("button", { name: vault.cancel }))
  await waitFor(() => expect(cancelExtensionInstall).toHaveBeenCalledWith("p9"))
  expect(confirmExtensionInstall).not.toHaveBeenCalled()
})

it("picks a .crx file and an unpacked folder through Rust, then confirms each", async () => {
  const user = userEvent.setup()
  ;(pickCrxExtension as jest.Mock).mockResolvedValue(
    pending({ pendingId: "crx", name: "Crx", source: "crx", hostPermissions: [] })
  )
  ;(pickUnpackedExtension as jest.Mock).mockResolvedValue(
    pending({
      pendingId: "dir",
      id: null,
      name: "Local Tool",
      source: "unpacked",
      permissions: [],
      hostPermissions: [],
    })
  )
  ;(confirmExtensionInstall as jest.Mock)
    .mockResolvedValueOnce(extension({ id: "c".repeat(32), name: "Crx" }))
    .mockResolvedValueOnce(
      extension({ id: "u".repeat(32), name: "Local Tool", source: "unpacked" })
    )
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  await user.click(screen.getByRole("button", { name: vault.install.crx }))
  expect(pickCrxExtension).toHaveBeenCalledWith()
  let dialog = await screen.findByRole("alertdialog")
  await user.click(within(dialog).getByRole("button", { name: vault.installConfirm.confirm }))
  await waitFor(() => expect(confirmExtensionInstall).toHaveBeenCalledWith("crx"))

  await user.click(screen.getByRole("button", { name: vault.install.unpacked }))
  expect(pickUnpackedExtension).toHaveBeenCalledWith()
  dialog = await screen.findByRole("alertdialog")
  expect(dialog).toHaveTextContent(vault.installConfirm.none)
  await user.click(within(dialog).getByRole("button", { name: vault.installConfirm.confirm }))
  await waitFor(() => expect(confirmExtensionInstall).toHaveBeenCalledWith("dir"))
  expect(await screen.findByText("Local Tool")).toBeInTheDocument()
  // The renderer never opens a file dialog or names a path.
  expect(openDialog).not.toHaveBeenCalled()
})

it("does nothing when the Rust picker is cancelled", async () => {
  const user = userEvent.setup()
  ;(pickCrxExtension as jest.Mock).mockResolvedValue(null)
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  await user.click(screen.getByRole("button", { name: vault.install.crx }))
  await waitFor(() => expect(pickCrxExtension).toHaveBeenCalled())
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(confirmExtensionInstall).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
})

it("maps typed install errors to their explanation", async () => {
  const user = userEvent.setup()
  ;(prepareWebStoreExtension as jest.Mock).mockRejectedValue(new Error("crx_id_mismatch: x"))
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  await user.type(screen.getByRole("textbox", { name: vault.install.label }), "abc")
  await user.click(screen.getByRole("button", { name: vault.install.webstore }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(vault.errors.crx_id_mismatch))
})

it("explains an expired confirmation", async () => {
  const user = userEvent.setup()
  ;(prepareWebStoreExtension as jest.Mock).mockResolvedValue(pending())
  ;(confirmExtensionInstall as jest.Mock).mockRejectedValue("extension_install_expired: again")
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  await user.type(screen.getByRole("textbox", { name: vault.install.label }), "abc")
  await user.click(screen.getByRole("button", { name: vault.install.webstore }))
  const dialog = await screen.findByRole("alertdialog")
  await user.click(within(dialog).getByRole("button", { name: vault.installConfirm.confirm }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(vault.errors.extension_install_expired)
  )
})

it("toggles, updates and removes an extension", async () => {
  const user = userEvent.setup()
  ;(setExtensionEnabled as jest.Mock).mockResolvedValue(extension({ enabled: false }))
  ;(checkExtensionUpdates as jest.Mock).mockResolvedValue([
    { id: extension().id, currentVersion: "1.0.0", availableVersion: "1.1.0" },
  ])
  ;(updateExtension as jest.Mock).mockResolvedValue(extension({ version: "1.1.0" }))
  ;(removeExtension as jest.Mock).mockResolvedValue(undefined)
  renderPanel()
  await screen.findByText("uBlock Origin Lite")

  await user.click(screen.getByRole("switch", { name: "Disable uBlock Origin Lite" }))
  await waitFor(() => expect(setExtensionEnabled).toHaveBeenCalledWith(extension().id, false))
  expect(await screen.findByRole("switch", { name: "Enable uBlock Origin Lite" })).not.toBeChecked()

  await user.click(screen.getByRole("button", { name: vault.checkUpdates }))
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/^1 update/)))
  await user.click(await screen.findByRole("button", { name: "Update to 1.1.0" }))
  await waitFor(() => expect(updateExtension).toHaveBeenCalledWith(extension().id))
  expect(await screen.findByText("Version 1.1.0")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Update to 1.1.0" })).toBeNull()

  await user.click(screen.getByRole("button", { name: vault.remove }))
  const confirm = await screen.findByRole("alertdialog")
  await user.click(within(confirm).getByRole("button", { name: vault.removeConfirm.confirm }))
  await waitFor(() => expect(removeExtension).toHaveBeenCalledWith(extension().id))
  expect(await screen.findByText(vault.empty)).toBeInTheDocument()
})

it("opens popup and options pages in the local session", async () => {
  const user = userEvent.setup()
  ;(localBrowser.rpc as jest.Mock).mockResolvedValue({})
  renderPanel("local-chromium", "session-1")
  await screen.findByText("uBlock Origin Lite")
  await user.click(screen.getByRole("button", { name: vault.openPopup }))
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.extension.open", {
    sessionId: "session-1",
    extensionId: extension().id,
    page: "popup",
    path: "popup.html",
  })
  await user.click(screen.getByRole("button", { name: vault.openOptions }))
  expect(localBrowser.rpc).toHaveBeenLastCalledWith(
    "browser.extension.open",
    expect.objectContaining({ page: "options", path: "options.html" })
  )
})

it("disables extension pages without a local session and says why", async () => {
  renderPanel("local-chromium")
  await screen.findByText("uBlock Origin Lite")
  expect(screen.getByRole("button", { name: vault.openPopup })).toBeDisabled()
  expect(screen.getByText(vault.openRequiresSession)).toBeInTheDocument()
})

it("reloads when the runtime reports extensions changed, and unsubscribes on unmount", async () => {
  const { unmount } = renderPanel()
  await screen.findByText("uBlock Origin Lite")
  ;(listExtensions as jest.Mock).mockResolvedValue([extension({ name: "Renamed" })])
  await waitFor(() => expect(eventHandler).not.toBeNull())
  eventHandler?.({ type: "pages.changed", sessionId: "s" })
  expect(listExtensions).toHaveBeenCalledTimes(1)
  eventHandler?.({ type: "extensions.changed", sessionId: "s" })
  expect(await screen.findByText("Renamed")).toBeInTheDocument()
  unmount()
  expect(unlisten).toHaveBeenCalled()
})

it("shows a retry when listing fails", async () => {
  const user = userEvent.setup()
  ;(listExtensions as jest.Mock).mockRejectedValueOnce(new Error("down"))
  renderPanel()
  expect(await screen.findByText(vault.loadFailed)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: vault.retry }))
  expect(await screen.findByText("uBlock Origin Lite")).toBeInTheDocument()
})

// CLAUDE.md rule 7, UI + test halves: extensions are dormant off local Chromium.
// The panel says so and keeps the list read-only instead of vanishing.
describe.each([
  ["embedded", vault.unsupported.embedded],
  ["user-chrome", vault.unsupported.userChrome],
  ["remote", vault.unsupported.remote],
] as const)("on the %s backend", (backend, reason) => {
  it("is labeled inert and read-only", async () => {
    const { container } = renderPanel(backend, "session-1")
    expect(await screen.findByText("uBlock Origin Lite")).toBeInTheDocument()
    expect(screen.getByTestId("browser-extensions-inert")).toHaveTextContent(reason)
    expect(container.querySelector("section")).toHaveAttribute("data-inert", "true")
    expect(screen.queryByRole("textbox", { name: vault.install.label })).toBeNull()
    expect(screen.queryByRole("button", { name: vault.remove })).toBeNull()
    expect(screen.getByRole("switch")).toBeDisabled()
  })
})

it("turns inert when the host reports extensions_unsupported_backend", async () => {
  const user = userEvent.setup()
  ;(setExtensionEnabled as jest.Mock).mockRejectedValue(new Error("extensions_unsupported_backend"))
  renderPanel()
  await screen.findByText("uBlock Origin Lite")
  await user.click(screen.getByRole("switch"))
  expect(await screen.findByTestId("browser-extensions-inert")).toHaveTextContent(
    vault.errors.extensions_unsupported_backend
  )
})
