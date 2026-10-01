/**
 * @jest-environment jsdom
 */

const invoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))
const dispatchPluginError = jest.fn()
jest.mock("@/lib/plugin/error-bus", () => ({
  dispatchPluginError: (...args: unknown[]) => dispatchPluginError(...args),
}))
const recordInstallOrigin = jest.fn(async () => undefined)
jest.mock("@/lib/plugin/origin/install-origin", () => ({
  recordInstallOrigin: (...args: unknown[]) => recordInstallOrigin(...(args as [])),
}))

import { installEmbeddedPlugin, readInstalledPluginTree } from "./plugin-tree"

const text = (value: string) => new TextEncoder().encode(value)
const provenance = { cogpackId: "writer", version: "1.0.0", fingerprint: "f" }

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
})

describe("plugin trees", () => {
  it("reads an installed plugin's files", async () => {
    invoke.mockResolvedValueOnce({
      pluginId: "notes",
      files: [{ path: "plugin.json", base64: btoa("{}"), size: 2 }],
      totalBytes: 2,
    })
    const files = await readInstalledPluginTree("notes")
    expect(invoke).toHaveBeenCalledWith("plugin_export_tree", { pluginId: "notes" })
    expect(files).toEqual([{ path: "plugin.json", bytes: text("{}") }])
  })

  it("installs embedded files and records where they came from", async () => {
    invoke.mockResolvedValueOnce({ pluginId: "notes", warnings: ["w"] })
    const result = await installEmbeddedPlugin(new Map([["plugin.json", text("{}")]]), {
      pluginId: "notes",
      version: "0.2.0",
      viaCogpack: provenance,
    })
    expect(invoke).toHaveBeenCalledWith("plugin_install_from_files", {
      pluginId: "notes",
      files: [{ path: "plugin.json", base64: btoa("{}") }],
    })
    expect(result).toEqual({ pluginId: "notes", warnings: ["w"] })
    expect(recordInstallOrigin).toHaveBeenCalledWith({
      pluginId: "notes",
      version: "0.2.0",
      origin: { kind: "local", via: "cogpack-embedded" },
      viaCogpack: provenance,
    })
  })

  it("reports a failed install on the plugin error bus", async () => {
    invoke.mockRejectedValueOnce(new Error("invalid manifest"))
    await expect(
      installEmbeddedPlugin(new Map([["plugin.json", text("{}")]]), {
        pluginId: "notes",
        pluginName: "Notes",
        version: "0.2.0",
        viaCogpack: provenance,
      })
    ).rejects.toThrow("invalid manifest")
    expect(dispatchPluginError).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: "Notes", message: "invalid manifest" })
    )
    expect(recordInstallOrigin).not.toHaveBeenCalled()
  })

  it("needs the desktop app", async () => {
    tauri = false
    await expect(readInstalledPluginTree("x")).rejects.toThrow("desktop app")
    await expect(
      installEmbeddedPlugin(new Map(), { pluginId: "notes", version: "1", viaCogpack: provenance })
    ).rejects.toThrow("desktop app")
  })
})
