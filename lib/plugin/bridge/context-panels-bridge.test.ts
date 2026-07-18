import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { PluginManifest } from "@/types/plugin"
import {
  registerContextPanelsForPlugin,
  unregisterContextPanelsForPlugin,
} from "./context-panels-bridge"

const manifest = {
  id: "review-plugin",
  name: "Review Plugin",
  version: "1.0.0",
  type: "frontend",
  permissions: ["extension:ui", "canvas:read"],
  capabilities: ["context-panel"],
  contextPanels: [
    {
      id: "outline",
      entry: "dist/panels.js",
      export: "OutlinePanel",
      resourceKinds: ["canvas-document"],
      activity: "inspect",
      labelKey: "panels.outline",
      label: "Outline",
      icon: "file-text",
      requiredCapabilities: ["inspect"],
      retention: "stateful",
    },
  ],
} satisfies PluginManifest

afterEach(() => unregisterContextPanelsForPlugin(manifest.id))

it("loads and registers declarative panels through the namespaced registry", async () => {
  const Renderer = () => null
  const result = await registerContextPanelsForPlugin(manifest, "/plugins/review", {
    importer: async (entry) => {
      expect(entry).toBe("/plugins/review/dist/panels.js")
      return { OutlinePanel: Renderer }
    },
    hasPermission: () => true,
  })

  expect(result).toEqual({ registered: 1, errors: [] })
  expect(
    contextPanelRegistry.resolve(
      {
        kind: "canvas-document",
        documentId: "doc-1",
        revision: "1",
        capabilities: ["inspect"],
      },
      new Set()
    )
  ).toEqual([
    expect.objectContaining({
      id: "review-plugin:outline",
      label: "Outline",
      pluginId: "review-plugin",
      renderer: Renderer,
    }),
  ])
})

it("fails closed when a resource permission is missing", async () => {
  const result = await registerContextPanelsForPlugin(manifest, "/plugins/review", {
    importer: async () => ({ OutlinePanel: () => null }),
    hasPermission: (permission) => permission === "extension:ui",
  })

  expect(result.registered).toBe(0)
  expect(result.errors[0]?.message).toMatch(/canvas:read/)
})

it("isolates missing exports without leaving a partial panel", async () => {
  const result = await registerContextPanelsForPlugin(manifest, "/plugins/review", {
    importer: async () => ({}),
    hasPermission: () => true,
  })

  expect(result.registered).toBe(0)
  expect(result.errors[0]?.message).toMatch(/OutlinePanel/)
  expect(contextPanelRegistry.get("review-plugin:outline")).toBeUndefined()
})
