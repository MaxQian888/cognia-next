/**
 * @jest-environment jsdom
 */

import {
  installPluginFromDirectory,
  previewLocalManifest,
  type InstallFromDirectoryReceipt,
} from "./install-from-directory"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/logging", () => ({
  loggers: {
    plugin: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

jest.mock("@/lib/plugin/error-bus", () => ({
  dispatchPluginError: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { dispatchPluginError } from "@/lib/plugin/error-bus"

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockDispatch = dispatchPluginError as jest.MockedFunction<typeof dispatchPluginError>

beforeEach(() => {
  mockInvoke.mockReset()
  mockIsTauri.mockReset()
  mockDispatch.mockReset()
  mockIsTauri.mockReturnValue(true)
})

describe("installPluginFromDirectory", () => {
  it("calls plugin_install_from_directory and returns the receipt", async () => {
    mockInvoke.mockResolvedValueOnce({ pluginId: "demo-plugin", warnings: [] })
    const receipt: InstallFromDirectoryReceipt = await installPluginFromDirectory("C:/plugins/demo")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_install_from_directory", {
      sourceDir: "C:/plugins/demo",
    })
    expect(receipt).toEqual({ pluginId: "demo-plugin", warnings: [] })
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("normalizes missing warnings to an empty array", async () => {
    mockInvoke.mockResolvedValueOnce({ pluginId: "demo", warnings: undefined as never })
    const receipt = await installPluginFromDirectory("C:/plugins/demo")
    expect(receipt.warnings).toEqual([])
  })

  it("dispatches a plugin:error and rethrows when invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("plugin.json missing"))
    await expect(installPluginFromDirectory("C:/plugins/broken")).rejects.toThrow(
      /plugin.json missing/
    )
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({
      stage: "local-install",
      message: expect.stringContaining("plugin.json missing"),
      severity: "error",
      recoverable: true,
    })
  })

  it("short-circuits with a descriptive error when not running in Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(installPluginFromDirectory("C:/plugins/demo")).rejects.toThrow(
      /only available in the desktop app/i
    )
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "local-install",
        recoverable: false,
      })
    )
  })

  it("forwards the optional pluginName to the error-bus dispatch on failure", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("kaboom"))
    await expect(
      installPluginFromDirectory("C:/plugins/demo", { pluginName: "Demo Plugin" })
    ).rejects.toThrow(/kaboom/)
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: "Demo Plugin" })
    )
  })
})

describe("previewLocalManifest", () => {
  it("calls preview_local_manifest and returns the parsed manifest", async () => {
    mockInvoke.mockResolvedValueOnce({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      type: "frontend",
    })
    const manifest = await previewLocalManifest("C:/plugins/demo")
    expect(mockInvoke).toHaveBeenCalledWith("preview_local_manifest", {
      sourceDir: "C:/plugins/demo",
    })
    expect(manifest.id).toBe("demo")
  })

  it("rejects with a desktop-only error when not running in Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(previewLocalManifest("C:/plugins/demo")).rejects.toThrow(
      /only available in the desktop app/i
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("does NOT dispatch to the error bus on failure (validator surfaces inline)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("invalid plugin.json"))
    await expect(previewLocalManifest("C:/plugins/broken")).rejects.toThrow(/invalid plugin.json/)
    expect(mockDispatch).not.toHaveBeenCalled()
  })
})
