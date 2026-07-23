import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { PluginManifest } from "@/types/plugin"
import {
  registerContextPanelsForPlugin,
  unregisterContextPanelsForPlugin,
} from "./context-panels-bridge"

const manifest = {
  id: "review-plugin",
  name: "Review Plugin",
  description: "Registers review panels in the Context Workbench.",
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
    contextPanelRegistry.resolve({
      kind: "canvas-document",
      documentId: "doc-1",
      revision: "1",
      capabilities: ["inspect"],
    })
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

it("resolves the behaviour hooks from the same entry module as the renderer", async () => {
  // These reach parity with the imperative path, which had lifecycle callbacks
  // from the start while manifest panels had none.
  const onFirstActivate = jest.fn()
  const onRestore = jest.fn()
  const getBadge = jest.fn(() => 3)
  const hooked = {
    ...manifest,
    contextPanels: [
      {
        ...manifest.contextPanels[0],
        onFirstActivateExport: "panelActivated",
        onRestoreExport: "panelRestored",
        getBadgeExport: "panelBadge",
        requiresChatScope: true,
      },
    ],
  } satisfies PluginManifest

  const result = await registerContextPanelsForPlugin(hooked, "/plugins/review", {
    importer: async () => ({
      OutlinePanel: () => null,
      panelActivated: onFirstActivate,
      panelRestored: onRestore,
      panelBadge: getBadge,
    }),
    hasPermission: () => true,
  })

  expect(result).toEqual({ registered: 1, errors: [] })
  const registered = contextPanelRegistry.get("review-plugin:outline")
  expect(registered?.requiresChatScope).toBe(true)
  const resource = {
    kind: "canvas-document" as const,
    documentId: "doc-1",
    revision: "1",
    capabilities: ["inspect" as const],
  }
  registered?.onFirstActivate?.(resource)
  registered?.onRestore?.(resource)
  expect(onFirstActivate).toHaveBeenCalledWith(resource)
  expect(onRestore).toHaveBeenCalledWith(resource)
  expect(registered?.getBadge?.(resource)).toBe(3)
})

it("reports a declared hook whose export is missing rather than registering it half-wired", async () => {
  const hooked = {
    ...manifest,
    contextPanels: [{ ...manifest.contextPanels[0], getBadgeExport: "panelBadge" }],
  } satisfies PluginManifest

  const result = await registerContextPanelsForPlugin(hooked, "/plugins/review", {
    importer: async () => ({ OutlinePanel: () => null }),
    hasPermission: () => true,
  })

  expect(result.registered).toBe(0)
  expect(result.errors[0]?.message).toMatch(/getBadge.*panelBadge/)
  expect(contextPanelRegistry.get("review-plugin:outline")).toBeUndefined()
})

it("rejects an unsafe entry even when runtime registration bypasses manifest validation", async () => {
  const unsafeManifest = {
    ...manifest,
    contextPanels: [{ ...manifest.contextPanels[0], entry: "../../outside.js" }],
  } satisfies PluginManifest
  const importer = jest.fn(async () => ({ OutlinePanel: () => null }))

  const result = await registerContextPanelsForPlugin(unsafeManifest, "/plugins/review", {
    importer,
    hasPermission: () => true,
  })

  expect(result.registered).toBe(0)
  expect(result.errors[0]?.message).toMatch(/unsafe plugin-relative path/i)
  expect(importer).not.toHaveBeenCalled()
})
