import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { CONTEXT_PANEL_WEBVIEW_CHANNEL } from "@/lib/plugin/bridge/context-panel-webview-protocol"
import {
  attachWebviewPoster,
  dispatchWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"
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
      icon: "FileText",
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

it("rejects a React panel that bypasses validation without entry/export", async () => {
  const invalidManifest = {
    ...manifest,
    contextPanels: [
      {
        ...manifest.contextPanels[0],
        entry: undefined,
        export: undefined,
      },
    ],
  } as unknown as PluginManifest
  const importer = jest.fn(async () => ({ OutlinePanel: () => null }))

  const result = await registerContextPanelsForPlugin(invalidManifest, "/plugins/review", {
    importer,
    hasPermission: () => true,
  })

  expect(result.registered).toBe(0)
  expect(result.errors[0]?.message).toMatch(/require both entry and export/)
  expect(importer).not.toHaveBeenCalled()
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

it("registers a webview-backed panel without touching the module importer", async () => {
  const importer = jest.fn(async () => ({}))
  const webviewManifest = {
    ...manifest,
    permissions: ["extension:ui", "session:read"],
    webviews: [{ id: "inspector", html: "<main></main>" }],
    contextPanels: [
      {
        id: "inspector",
        webview: "inspector",
        resourceKinds: ["session"],
        activity: "inspect",
        labelKey: "panels.inspector",
        label: "Inspector",
      },
    ],
  } satisfies PluginManifest

  const result = await registerContextPanelsForPlugin(webviewManifest, "/plugins/review", {
    importer,
    hasPermission: () => true,
  })

  expect(result).toEqual({ registered: 1, errors: [] })
  expect(importer).not.toHaveBeenCalled()
  const registered = contextPanelRegistry.get("review-plugin:inspector")
  expect(registered?.renderer).toBeDefined()
  expect(registered?.retention).toBe("stateful")
})

it("tears the webview RPC server down on unregister", async () => {
  const webviewManifest = {
    ...manifest,
    permissions: ["extension:ui", "session:read"],
    webviews: [{ id: "inspector", html: "<main></main>" }],
    contextPanels: [
      {
        id: "inspector",
        webview: "inspector",
        resourceKinds: ["session"],
        activity: "inspect",
        labelKey: "panels.inspector",
        label: "Inspector",
      },
    ],
  } satisfies PluginManifest
  await registerContextPanelsForPlugin(webviewManifest, "/plugins/review", {
    hasPermission: () => true,
  })

  const outbound: unknown[] = []
  const detach = attachWebviewPoster("review-plugin:inspector", (data) => {
    outbound.push(data)
    return true
  })
  const sendRequest = (id: number) =>
    dispatchWebviewMessage("review-plugin:inspector", {
      data: {
        channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
        kind: "request",
        id,
        method: "getActiveContext",
      },
    })

  sendRequest(1)
  expect(outbound).toHaveLength(1)

  unregisterContextPanelsForPlugin(webviewManifest.id)
  sendRequest(2)
  expect(outbound).toHaveLength(1)
  detach()
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
