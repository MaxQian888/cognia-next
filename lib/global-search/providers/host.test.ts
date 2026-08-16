import type { QuickActionEntry } from "@/lib/plugin/registries/quick-action-registry"

import { makeProviderInput, makeTestContext } from "../testing"
import { pluginActionsProvider, workbenchPanelsProvider } from "./host"

const host = (over: Partial<ReturnType<typeof makeTestContext>["host"]>) =>
  makeTestContext({
    host: {
      reachableSettingsSections: new Set(),
      recorderAvailable: false,
      theme: "light",
      hasApiKey: false,
      pluginQuickActions: [],
      workbenchPanels: [],
      ...over,
    },
  })

describe("host providers", () => {
  it("workbench panels: matches label / id / activity and reveals the panel", async () => {
    const ctx = host({
      workbenchPanels: [
        { id: "files", label: "Files", activity: "explorer" },
        { id: "term", label: "Terminal", activity: "tools" },
      ],
    })
    const out = await workbenchPanelsProvider.search(makeProviderInput("term", { ctx }))
    expect(out.items[0]).toMatchObject({
      id: "workbench-panel:term",
      title: "Terminal",
      meta: "tools",
      action: { type: "reveal-panel", panelId: "term" },
    })
    const byActivity = await workbenchPanelsProvider.search(makeProviderInput("explorer", { ctx }))
    expect(byActivity.items[0]!.id).toBe("workbench-panel:files")
    // Panels without an activity still match by label / id.
    const bare = host({ workbenchPanels: [{ id: "bare", label: "Bare panel" }] })
    const bareOut = await workbenchPanelsProvider.search(makeProviderInput("bare", { ctx: bare }))
    expect(bareOut.items[0]!.meta).toBeUndefined()
    const none = await workbenchPanelsProvider.search(makeProviderInput("zzz", { ctx }))
    expect(none.items).toEqual([])
  })

  it("plugin actions: matches title / description / plugin id and wraps the entry", async () => {
    const entry = {
      fullId: "demo:hello",
      pluginId: "demo",
      commandId: "cmd",
      surfaces: ["palette"],
      title: "Say hello",
      description: "greets you",
    } as unknown as QuickActionEntry
    const ctx = host({ pluginQuickActions: [entry] })
    const out = await pluginActionsProvider.search(makeProviderInput("hello", { ctx }))
    expect(out.items[0]).toMatchObject({
      id: "plugin-action:demo:hello",
      title: "Say hello",
      subtitle: "greets you",
      meta: "demo",
      action: { type: "quick-action", entry },
    })
    const byPlugin = await pluginActionsProvider.search(makeProviderInput("demo", { ctx }))
    expect(byPlugin.items).toHaveLength(1)
    const byDesc = await pluginActionsProvider.search(makeProviderInput("greets", { ctx }))
    expect(byDesc.items).toHaveLength(1)
    const terse = host({
      pluginQuickActions: [{ ...entry, description: "  " } as unknown as QuickActionEntry],
    })
    const terseOut = await pluginActionsProvider.search(makeProviderInput("hello", { ctx: terse }))
    expect(terseOut.items[0]!.subtitle).toBeUndefined()
  })
})
