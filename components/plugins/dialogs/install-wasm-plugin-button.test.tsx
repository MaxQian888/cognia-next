/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const installFromLocalMock = jest.fn()
const previewBundleManifestMock = jest.fn()
const dialogOpenMock = jest.fn()
const canUseTauriInvokeMock = jest.fn()

jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: () => canUseTauriInvokeMock(),
}))

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpenMock(...args),
}))

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    installWasmPluginFromLocalFile: (...args: unknown[]) => installFromLocalMock(...args),
  }),
}))

jest.mock("@/lib/plugin/package/http-installer", () => ({
  previewBundleManifest: (...args: unknown[]) => previewBundleManifestMock(...args),
}))

jest.mock("@/lib/plugin/security/wasm-grant", () => ({
  applyWasmCapabilityGrant: async (decision: {
    grantedPermissions: string[]
    grantedPreopens: string[]
  }) => ({
    permissions: decision.grantedPermissions,
    preopens: decision.grantedPreopens,
  }),
}))

import { InstallWasmPluginButton } from "./install-wasm-plugin-button"

const baseManifest = {
  id: "demo.wasm",
  name: "Demo WASM",
  version: "0.1.0",
  description: "x",
  type: "wasm" as const,
  capabilities: [],
  wasmMain: "main.wasm",
  wasm: { apiVersion: "0.1.0" },
  permissions: ["notification" as const],
  author: { name: "Alice", publicKey: "AAA=" },
}

beforeEach(() => {
  installFromLocalMock.mockReset()
  previewBundleManifestMock.mockReset()
  dialogOpenMock.mockReset()
  canUseTauriInvokeMock.mockReset()
  canUseTauriInvokeMock.mockReturnValue(true)
})

describe("InstallWasmPluginButton", () => {
  it("renders the button", () => {
    render(<InstallWasmPluginButton />)
    expect(screen.getByTestId("install-wasm-plugin-button")).toBeInTheDocument()
  })

  it("shows an error in browser mode and skips the file picker", async () => {
    canUseTauriInvokeMock.mockReturnValue(false)
    render(<InstallWasmPluginButton />)
    fireEvent.click(screen.getByTestId("install-wasm-plugin-button"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("tauriRequiredError"))
    expect(dialogOpenMock).not.toHaveBeenCalled()
  })

  it("aborts cleanly when the user dismisses the file picker", async () => {
    dialogOpenMock.mockResolvedValue(null)
    render(<InstallWasmPluginButton />)
    fireEvent.click(screen.getByTestId("install-wasm-plugin-button"))
    await waitFor(() => expect(dialogOpenMock).toHaveBeenCalled())
    expect(installFromLocalMock).not.toHaveBeenCalled()
  })

  it("aborts when the user picks a .zip and cancels the grant sheet", async () => {
    dialogOpenMock.mockResolvedValue("/tmp/demo.zip")
    previewBundleManifestMock.mockResolvedValue({
      manifest: baseManifest,
      path: "/tmp/demo.zip",
      signatureVerified: false,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a",
    })
    render(<InstallWasmPluginButton />)
    fireEvent.click(screen.getByTestId("install-wasm-plugin-button"))
    await waitFor(() =>
      expect(screen.getByTestId("wasm-capability-grant-sheet")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId("wasm-grant-cancel"))
    await waitFor(() => expect(installFromLocalMock).not.toHaveBeenCalled())
  })

  it("invokes installWasmPluginFromLocalFile after grant confirmation", async () => {
    const onInstalled = jest.fn()
    dialogOpenMock.mockResolvedValue("/tmp/demo.zip")
    previewBundleManifestMock.mockResolvedValue({
      manifest: baseManifest,
      path: "/tmp/demo.zip",
      signatureVerified: false,
      authorPublicKey: undefined,
      authorFingerprint: undefined,
    })
    installFromLocalMock.mockResolvedValue({
      manifest: baseManifest,
      status: "installed",
      source: "local",
      path: "/plugins/demo.wasm",
      config: {},
    })
    render(<InstallWasmPluginButton onInstalled={onInstalled} />)
    fireEvent.click(screen.getByTestId("install-wasm-plugin-button"))
    await waitFor(() =>
      expect(screen.getByTestId("wasm-capability-grant-sheet")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId("wasm-grant-confirm"))
    await waitFor(() => expect(installFromLocalMock).toHaveBeenCalled())
    expect(installFromLocalMock.mock.calls[0][0]).toBe("/tmp/demo.zip")
    const grantDecision = installFromLocalMock.mock.calls[0][1]
    expect(grantDecision.pluginId).toBe("demo.wasm")
    expect(onInstalled).toHaveBeenCalledWith("demo.wasm")
  })

  it("uses a synthetic manifest for bare .wasm sideloads (no preview)", async () => {
    dialogOpenMock.mockResolvedValue("/tmp/my-plugin.wasm")
    installFromLocalMock.mockResolvedValue({
      manifest: { ...baseManifest, id: "my-plugin" },
      status: "installed",
      source: "local",
      path: "/plugins/my-plugin",
      config: {},
    })
    render(<InstallWasmPluginButton />)
    fireEvent.click(screen.getByTestId("install-wasm-plugin-button"))
    await waitFor(() =>
      expect(screen.getByTestId("wasm-capability-grant-sheet")).toBeInTheDocument()
    )
    // No preview should have been requested for bare .wasm.
    expect(previewBundleManifestMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("wasm-grant-confirm"))
    await waitFor(() => expect(installFromLocalMock).toHaveBeenCalled())
  })

  it("surfaces install errors in the alert region", async () => {
    dialogOpenMock.mockResolvedValue("/tmp/demo.zip")
    previewBundleManifestMock.mockResolvedValue({
      manifest: baseManifest,
      path: "/tmp/demo.zip",
      signatureVerified: false,
    })
    installFromLocalMock.mockRejectedValue(new Error("boom"))
    render(<InstallWasmPluginButton />)
    fireEvent.click(screen.getByTestId("install-wasm-plugin-button"))
    await waitFor(() =>
      expect(screen.getByTestId("wasm-capability-grant-sheet")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId("wasm-grant-confirm"))
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("boom")
    })
  })
})
