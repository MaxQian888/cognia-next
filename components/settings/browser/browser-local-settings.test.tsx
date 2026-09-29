/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/components/ui/dialog")
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/browser/use-local-browser", () => ({ useLocalBrowser: jest.fn() }))
jest.mock("@/lib/browser/agent-engine", () => ({ setLocalChromiumInstalled: jest.fn() }))
jest.mock("@/lib/browser/downloads-client", () => ({
  getDownloadsDir: jest.fn(),
  chooseDownloadsDir: jest.fn(),
  resetDownloadsDir: jest.fn(),
  setAskWhereToSave: jest.fn(),
}))
jest.mock("@/lib/browser/extensions-client", () => ({ listExtensions: jest.fn() }))
jest.mock("@/lib/browser/passwords", () => ({ listCredentials: jest.fn() }))
jest.mock("@/lib/db/browser-mirrors", () => ({
  listBrowserCredentialMeta: jest.fn(),
  listBrowserExtensionMirror: jest.fn(),
  replaceBrowserCredentialMeta: jest.fn().mockResolvedValue(undefined),
  replaceBrowserExtensionMirror: jest.fn().mockResolvedValue(undefined),
}))
// The mirror readers are mocked to answer synchronously, so the query is its value.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => factory(),
}))
jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@tauri-apps/api/path", () => ({
  appDataDir: jest.fn().mockResolvedValue("/data"),
  join: jest.fn(async (...parts: string[]) => parts.join("/")),
}))
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn() }))
jest.mock("@/components/browser/vault/browser-password-manager", () => ({
  BrowserPasswordManager: () => <div data-testid="password-manager" />,
}))
jest.mock("@/components/browser/extensions/browser-extensions-panel", () => ({
  BrowserExtensionsPanel: ({ backend }: { backend: string }) => (
    <div data-testid="extensions-panel">{backend}</div>
  ),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

let mockSettings: Record<string, unknown> = {}
const mockSave = jest.fn().mockResolvedValue(undefined)

import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"

import type { LocalBrowserState } from "@/hooks/browser/use-local-browser"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import {
  chooseDownloadsDir,
  getDownloadsDir,
  resetDownloadsDir,
  setAskWhereToSave,
} from "@/lib/browser/downloads-client"
import { listExtensions } from "@/lib/browser/extensions-client"
import { listCredentials } from "@/lib/browser/passwords"
import {
  listBrowserCredentialMeta,
  listBrowserExtensionMirror,
  replaceBrowserCredentialMeta,
  replaceBrowserExtensionMirror,
} from "@/lib/db/browser-mirrors"
import { revealInExplorer } from "@/lib/tauri/opener"
import { setLocalChromiumInstalled } from "@/lib/browser/agent-engine"

import { BrowserLocalSettings } from "./browser-local-settings"

const STATUS = {
  installed: true,
  installing: false,
  chromiumVersion: "140.0.1",
  running: false,
  runtimeStaged: true,
  error: null,
}

function localState(overrides: Partial<LocalBrowserState> = {}): LocalBrowserState {
  return {
    supported: true,
    status: STATUS,
    progress: null,
    userChrome: [],
    busy: false,
    error: null,
    refresh: jest.fn(),
    install: jest.fn(),
    uninstall: jest.fn().mockResolvedValue(true),
    discoverUserChrome: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = {}
  ;(useLocalBrowser as jest.Mock).mockReturnValue(localState())
  ;(getDownloadsDir as jest.Mock).mockResolvedValue({
    path: "/Users/me/Downloads",
    isDefault: true,
    askWhereToSave: false,
  })
  ;(chooseDownloadsDir as jest.Mock).mockResolvedValue(null)
  ;(resetDownloadsDir as jest.Mock).mockResolvedValue({
    path: "/Users/me/Downloads",
    isDefault: true,
    askWhereToSave: false,
  })
  ;(setAskWhereToSave as jest.Mock).mockImplementation(async (askWhereToSave: boolean) => ({
    path: "/Volumes/Data/dl",
    isDefault: false,
    askWhereToSave,
  }))
  ;(listExtensions as jest.Mock).mockResolvedValue([{ id: "e" }])
  ;(listCredentials as jest.Mock).mockResolvedValue([{ id: "c" }])
  ;(listBrowserExtensionMirror as jest.Mock).mockReturnValue([{ id: "e1" }, { id: "e2" }])
  ;(listBrowserCredentialMeta as jest.Mock).mockReturnValue([{ id: "c1" }])
})

async function renderSettings() {
  render(<BrowserLocalSettings desktop />)
  await screen.findByText("/Users/me/Downloads")
}

it("explains itself off the desktop", () => {
  render(<BrowserLocalSettings desktop={false} />)
  expect(screen.getByText("The local browser is available in the desktop app.")).toBeInTheDocument()
  expect(getDownloadsDir).not.toHaveBeenCalled()
})

it("shows Chromium, downloads, profile and vault summaries, and refreshes the mirrors", async () => {
  await renderSettings()
  expect(screen.getByTestId("browser-chromium-status")).toHaveTextContent(
    "Installed · Chromium 140.0.1"
  )
  expect(screen.getByText("Default")).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByTestId("browser-profile-path")).toHaveTextContent(
      "/data/browser/profiles/default"
    )
  )
  expect(screen.getByTestId("browser-extensions-count")).toHaveTextContent("2 extensions installed")
  expect(screen.getByTestId("browser-passwords-count")).toHaveTextContent("1 saved sign-in")
  await waitFor(() => expect(replaceBrowserExtensionMirror).toHaveBeenCalledWith([{ id: "e" }]))
  expect(setLocalChromiumInstalled).toHaveBeenCalledWith(true)
  expect(replaceBrowserCredentialMeta).toHaveBeenCalledWith([{ id: "c" }])
})

it("saves the default engine and the Chrome to attach", async () => {
  mockSettings = { browserDefaultBackend: "user-chrome" }
  ;(useLocalBrowser as jest.Mock).mockReturnValue(
    localState({
      userChrome: [
        {
          browser: "chrome",
          label: "Google Chrome",
          userDataDir: "/c",
          available: true,
          reason: null,
        },
        {
          browser: "brave",
          label: "Brave",
          userDataDir: "/b",
          available: false,
          reason: "not_installed",
        },
      ],
    })
  )
  await renderSettings()
  fireEvent.change(screen.getByLabelText("Default engine"), { target: { value: "local-chromium" } })
  expect(mockSave).toHaveBeenCalledWith({ browserDefaultBackend: "local-chromium" })
  const browserSelect = screen.getByRole("combobox", { name: "Browser to attach" })
  expect(Array.from((browserSelect as HTMLSelectElement).options).map((o) => o.value)).toEqual([
    "chrome",
  ])
  fireEvent.change(browserSelect, { target: { value: "chrome" } })
  expect(mockSave).toHaveBeenCalledWith({ browserUserChromeBrowser: "chrome" })
})

it("uninstalls Chromium and reports the outcome", async () => {
  const state = localState()
  ;(useLocalBrowser as jest.Mock).mockReturnValue(state)
  await renderSettings()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }))
  })
  expect(state.uninstall).toHaveBeenCalled()
  expect(toast.success).toHaveBeenCalledWith("Chromium was removed.")

  ;(state.uninstall as jest.Mock).mockResolvedValue(false)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }))
  })
  expect(toast.error).toHaveBeenCalled()
})

it("offers the install when Chromium is missing", async () => {
  ;(useLocalBrowser as jest.Mock).mockReturnValue(
    localState({ status: { ...STATUS, installed: false, chromiumVersion: null } })
  )
  await renderSettings()
  expect(screen.getByTestId("browser-chromium-status")).toHaveTextContent("Not installed")
  expect(screen.getByRole("button", { name: "Install Chromium" })).toBeInTheDocument()
})

it("changes, resets and toggles the download folder through Rust", async () => {
  ;(chooseDownloadsDir as jest.Mock).mockResolvedValue({
    path: "/Volumes/Data/dl",
    isDefault: false,
    askWhereToSave: false,
  })
  await renderSettings()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Change…" }))
  })
  // Rust shows the picker; the renderer never opens a dialog or names a path.
  expect(chooseDownloadsDir).toHaveBeenCalledWith(false)
  expect(openDialog).not.toHaveBeenCalled()
  await screen.findByText("/Volumes/Data/dl")

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Ask where to save each file" }))
  })
  expect(setAskWhereToSave).toHaveBeenLastCalledWith(true)

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Use the system Downloads folder" }))
  })
  expect(resetDownloadsDir).toHaveBeenCalled()
  await screen.findByText("/Users/me/Downloads")
})

it("keeps the folder when the picker is cancelled", async () => {
  await renderSettings()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Change…" }))
  })
  expect(chooseDownloadsDir).toHaveBeenCalled()
  expect(screen.getByText("/Users/me/Downloads")).toBeInTheDocument()
  expect(toast.error).not.toHaveBeenCalled()
})

it("explains a refused folder", async () => {
  ;(chooseDownloadsDir as jest.Mock).mockRejectedValue(
    "downloads_dir_forbidden: the home directory itself"
  )
  await renderSettings()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Change…" }))
  })
  expect(toast.error).toHaveBeenCalledWith(
    "That folder can't hold downloads. Choose one that isn't your home folder, a system folder or a hidden folder."
  )
})

it("reports a folder it could not save or read", async () => {
  ;(setAskWhereToSave as jest.Mock).mockRejectedValue(new Error("denied"))
  await renderSettings()
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Ask where to save each file" }))
  })
  expect(toast.error).toHaveBeenCalledWith("Could not save the download settings")
})

it("reports a download folder it could not read", async () => {
  ;(getDownloadsDir as jest.Mock).mockRejectedValue(new Error("nope"))
  render(<BrowserLocalSettings desktop />)
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Could not read the download settings")
  )
})

it("reveals the profile folder", async () => {
  await renderSettings()
  const reveal = await screen.findByRole("button", { name: "Show in folder" })
  fireEvent.click(reveal)
  expect(revealInExplorer).toHaveBeenCalledWith("/data/browser/profiles/default")
})

it("opens the password manager and the extension manager, re-mirroring on close", async () => {
  await renderSettings()
  fireEvent.click(screen.getByRole("button", { name: "Manage passwords" }))
  expect(screen.getByTestId("password-manager")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Manage extensions" }))
  expect(screen.getByTestId("extensions-panel")).toHaveTextContent("local-chromium")
})
