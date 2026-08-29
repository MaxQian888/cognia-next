import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}))

jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: jest.fn(() => true),
}))

jest.mock("@/lib/plugin/local/install-from-directory", () => ({
  previewLocalManifest: jest.fn(),
  installPluginFromDirectory: jest.fn(),
}))

const mockPreInstall = jest.fn()
jest.mock("@/hooks/plugins/use-plugin-pre-install", () => ({
  usePluginPreInstall: () => ({
    target: null,
    install: mockPreInstall,
    resolveContinue: jest.fn(),
    resolveCancel: jest.fn(),
  }),
}))

const mockCreateLocalDirectoryClient = jest.fn((_sourceDir: string) => ({
  kind: "local-directory",
}))
jest.mock("@/lib/plugin/local/local-directory-client", () => ({
  createLocalDirectoryClient: (sourceDir: string) => mockCreateLocalDirectoryClient(sourceDir),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { canUseTauriInvoke } from "@/lib/native/utils"
import * as dialogPlugin from "@tauri-apps/plugin-dialog"
import {
  previewLocalManifest,
  installPluginFromDirectory,
} from "@/lib/plugin/local/install-from-directory"
import { LoadUnpackedButton, useLoadUnpackedFlow } from "./load-unpacked-button"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sonner = require("sonner") as { toast: { success: jest.Mock; error: jest.Mock } }

const mockOpen = dialogPlugin.open as jest.MockedFunction<typeof dialogPlugin.open>
const mockCanUse = canUseTauriInvoke as jest.MockedFunction<typeof canUseTauriInvoke>
const mockPreview = previewLocalManifest as jest.MockedFunction<typeof previewLocalManifest>
const mockInstall = installPluginFromDirectory as jest.MockedFunction<
  typeof installPluginFromDirectory
>

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockOpen.mockReset()
  mockCanUse.mockReset()
  mockCanUse.mockReturnValue(true)
  mockPreview.mockReset()
  mockInstall.mockReset()
  mockPreInstall.mockReset()
  mockCreateLocalDirectoryClient.mockClear()
  sonner.toast.success.mockReset()
  sonner.toast.error.mockReset()
})

describe("LoadUnpackedButton", () => {
  it("renders the localized label", () => {
    renderWithIntl(<LoadUnpackedButton />)
    expect(
      screen.getByRole("button", { name: enMessages.plugins.loadUnpacked.label })
    ).toBeInTheDocument()
  })

  it("shows the tauri-required error and skips the picker on web", async () => {
    mockCanUse.mockReturnValue(false)
    renderWithIntl(<LoadUnpackedButton />)
    await userEvent.click(screen.getByTestId("load-unpacked-button"))
    expect(mockOpen).not.toHaveBeenCalled()
    expect(screen.getByText(enMessages.plugins.loadUnpacked.tauriRequiredError)).toBeInTheDocument()
  })

  it("noops silently when the user cancels the directory picker", async () => {
    mockOpen.mockResolvedValueOnce(null as never)
    renderWithIntl(<LoadUnpackedButton />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })
    expect(mockPreview).not.toHaveBeenCalled()
    expect(mockInstall).not.toHaveBeenCalled()
    expect(sonner.toast.success).not.toHaveBeenCalled()
  })

  it("surfaces a manifest preview failure as an inline error", async () => {
    mockOpen.mockResolvedValueOnce("C:/plugins/broken")
    mockPreview.mockRejectedValueOnce(new Error("invalid plugin.json"))
    const onInstalled = jest.fn()
    renderWithIntl(<LoadUnpackedButton onInstalled={onInstalled} />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("invalid plugin.json")
    expect(mockInstall).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it("installs a provided dropped directory without reopening the picker", async () => {
    mockPreview.mockResolvedValueOnce({
      id: "demo.plugin",
      name: "Demo Plugin",
      version: "1.2.3",
      type: "frontend",
    } as never)
    mockPreInstall.mockResolvedValueOnce({ status: "installed", pluginId: "demo.plugin" })
    const onInstalled = jest.fn()

    function DroppedDirectoryHarness() {
      const flow = useLoadUnpackedFlow({ onInstalled })
      return <button onClick={() => void flow.trigger("/tmp/demo-plugin")}>Install dropped</button>
    }

    renderWithIntl(<DroppedDirectoryHarness />)
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Install dropped" }))
    })

    expect(mockOpen).not.toHaveBeenCalled()
    expect(mockPreview).toHaveBeenCalledWith("/tmp/demo-plugin")
    expect(mockCreateLocalDirectoryClient).toHaveBeenCalledWith("/tmp/demo-plugin")
    expect(mockPreInstall).toHaveBeenCalledWith(
      "demo.plugin",
      "1.2.3",
      "Demo Plugin",
      expect.objectContaining({ kind: "local-directory" })
    )
    expect(onInstalled).toHaveBeenCalledWith("demo.plugin")
  })
})
