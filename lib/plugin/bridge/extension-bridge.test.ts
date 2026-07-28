import React from "react"
import { clearPluginExtensions, getPluginExtensions } from "@/lib/plugin/api/extension-api"
import { registerExtensionsForPlugin } from "./extension-bridge"
import type { PluginManifest } from "@/types/plugin/plugin"

const manifest = {
  id: "declarative-extension",
  name: "Declarative Extension",
  version: "1.0.0",
  description: "test",
  type: "frontend",
  capabilities: ["components"],
  permissions: ["extension:ui"],
  main: "dist/index.js",
  extensions: [
    {
      point: "chat.input.actions",
      entry: "dist/surfaces.js",
      export: "ComposerAction",
      priority: 15,
      when: "chat.active",
      minWidth: 24,
      maxWidth: 40,
      labelKey: "surfaces.composerAction",
    },
  ],
} satisfies PluginManifest

describe("extension-bridge", () => {
  afterEach(() => {
    clearPluginExtensions(manifest.id)
  })

  it("registers a named React export with declarative options", async () => {
    const ComposerAction = () => React.createElement("button", null, "Action")
    const importer = jest.fn().mockResolvedValue({ ComposerAction })

    const result = await registerExtensionsForPlugin(manifest, "/plugins/declarative-extension", {
      importer,
      hasPermission: (permission) => permission === "extension:ui",
    })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).toHaveBeenCalledWith("/plugins/declarative-extension/dist/surfaces.js")
    expect(getPluginExtensions(manifest.id)).toEqual([
      expect.objectContaining({
        pluginId: manifest.id,
        point: "chat.input.actions",
        component: ComposerAction,
        options: {
          priority: 15,
          labelKey: "surfaces.composerAction",
          condition: undefined,
          when: "chat.active",
          minWidth: 24,
          maxWidth: 40,
        },
      }),
    ])
  })

  it("reports missing exports without registering a partial contribution", async () => {
    const result = await registerExtensionsForPlugin(manifest, "/plugins/declarative-extension", {
      importer: async () => ({}),
      hasPermission: () => true,
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]?.message).toContain('has no React export named "ComposerAction"')
    expect(getPluginExtensions(manifest.id)).toEqual([])
  })

  it("returns an empty result when the manifest has no extensions", async () => {
    const importer = jest.fn()
    await expect(
      registerExtensionsForPlugin(
        { ...manifest, extensions: undefined },
        "/plugins/declarative-extension",
        {
          importer,
          hasPermission: () => true,
        }
      )
    ).resolves.toEqual({ registered: 0, errors: [] })
    expect(importer).not.toHaveBeenCalled()
  })

  it("normalizes non-Error import failures", async () => {
    const result = await registerExtensionsForPlugin(manifest, "/plugins/declarative-extension", {
      importer: async () => Promise.reject("module unavailable"),
      hasPermission: () => true,
    })

    expect(result.errors[0]?.message).toBe("module unavailable")
  })
})
