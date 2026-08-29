import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { TooltipProvider } from "@/components/ui/tooltip"
import { CogniaCliLauncher } from "./cognia-cli-launcher"
import { useDevProjectStore } from "@/stores/plugins/dev-project-store"
import { usePluginDevSessionStore } from "@/stores/plugins/plugin-dev-session-store"

// --- Mocks -----------------------------------------------------------------

const mockStatus = jest.fn()
jest.mock("@/hooks/plugins/use-cognia-cli-status", () => ({
  useCogniaCliStatus: () => mockStatus(),
}))

const launchCognia = jest.fn().mockResolvedValue({ kind: "launched", sessionId: "s1" })
jest.mock("@/lib/terminal/run-cognia", () => ({
  launchCognia: (...args: unknown[]) => launchCognia(...args),
}))

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ setPanelOpen: jest.fn() }) },
}))

const previewLocalManifest = jest.fn()
jest.mock("@/lib/plugin/local/install-from-directory", () => ({
  previewLocalManifest: (...args: unknown[]) => previewLocalManifest(...args),
}))

const dialogOpen = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
}))

const toastWarning = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    warning: (...a: unknown[]) => toastWarning(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

function status(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    installed: true,
    version: "cognia 0.1.0",
    path: "/usr/bin/cognia",
    detection: null,
    bridge: { running: true, boundPort: 7890, endpointFile: "/x" },
    supported: true,
    refresh: jest.fn(),
    ...overrides,
  }
}

function renderLauncher() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TooltipProvider>
        <CogniaCliLauncher />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  useDevProjectStore.getState().clearProject()
  usePluginDevSessionStore.getState().clear()
  mockStatus.mockReturnValue(status())
})

// --- Tests -----------------------------------------------------------------

describe("CogniaCliLauncher", () => {
  it("shows the desktop-only marker and no run buttons when unsupported", () => {
    mockStatus.mockReturnValue(status({ supported: false }))
    renderLauncher()
    expect(screen.getByTestId("cognia-cli-launcher")).toBeInTheDocument()
    expect(screen.queryByTestId("cognia-cli-run-build")).not.toBeInTheDocument()
  })

  it("disables commands and shows a hint when the CLI is missing", () => {
    mockStatus.mockReturnValue(status({ installed: false }))
    renderLauncher()
    expect(screen.getByTestId("cognia-cli-launcher-missing")).toBeInTheDocument()
    expect(screen.getByTestId("cognia-cli-run-build")).toBeDisabled()
  })

  it("keeps project commands disabled until a project is chosen", () => {
    renderLauncher()
    expect(screen.getByTestId("cognia-cli-run-build")).toBeDisabled()
    // Install doesn't need a project dir.
    expect(screen.getByTestId("cognia-cli-run-install")).toBeEnabled()
  })

  it("runs `cognia plugin build` in the selected project dir", async () => {
    useDevProjectStore.getState().setProject("/proj", "Demo")
    renderLauncher()
    await userEvent.click(screen.getByTestId("cognia-cli-run-build"))
    expect(launchCognia).toHaveBeenCalledWith(
      expect.objectContaining({ command: "plugin build", cwd: "/proj" })
    )
  })

  it("picks a project directory and validates its manifest", async () => {
    dialogOpen.mockResolvedValue("/picked/plugin")
    previewLocalManifest.mockResolvedValue({ name: "Picked Plugin", version: "1.0.0" })
    renderLauncher()
    await userEvent.click(screen.getByTestId("cognia-cli-pick-project"))
    expect(previewLocalManifest).toHaveBeenCalledWith("/picked/plugin")
    expect(await screen.findByTestId("cognia-cli-project-dir")).toHaveTextContent("/picked/plugin")
    expect(useDevProjectStore.getState().projectDir).toBe("/picked/plugin")
  })

  it("warns but still records the dir when the folder has no valid manifest", async () => {
    dialogOpen.mockResolvedValue("/picked/notaplugin")
    previewLocalManifest.mockRejectedValue(new Error("no plugin.json"))
    renderLauncher()
    await userEvent.click(screen.getByTestId("cognia-cli-pick-project"))
    expect(toastWarning).toHaveBeenCalled()
    expect(useDevProjectStore.getState().projectDir).toBe("/picked/notaplugin")
  })

  it("warns when running a bridge-dependent command while the bridge is down", async () => {
    useDevProjectStore.getState().setProject("/proj", "Demo")
    mockStatus.mockReturnValue(
      status({ bridge: { running: false, boundPort: null, endpointFile: null } })
    )
    renderLauncher()
    expect(screen.getByTestId("cognia-cli-bridge-hint")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("cognia-cli-run-dev"))
    expect(toastWarning).toHaveBeenCalled()
    expect(launchCognia).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/^plugin dev --session-id [0-9a-f-]+$/),
        cwd: "/proj",
      })
    )
    expect(usePluginDevSessionStore.getState().sessions[0]?.terminalSessionId).toBe("s1")
  })

  it("installs a picked bundle via `cognia plugin install`", async () => {
    dialogOpen.mockResolvedValue("/bundles/demo.zip")
    renderLauncher()
    await userEvent.click(screen.getByTestId("cognia-cli-run-install"))
    expect(launchCognia).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'plugin install "/bundles/demo.zip"' })
    )
  })

  it("surfaces a launch error as a toast", async () => {
    launchCognia.mockResolvedValueOnce({ kind: "error", message: "spawn failed" })
    useDevProjectStore.getState().setProject("/proj", "Demo")
    renderLauncher()
    await userEvent.click(screen.getByTestId("cognia-cli-run-lint"))
    expect(toastError).toHaveBeenCalled()
  })
})
