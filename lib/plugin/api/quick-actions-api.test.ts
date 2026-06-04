/**
 * Tests for the plugin-facing quick-actions API: capability gating + the
 * register/registerMany disposer contract.
 */

import { createQuickActionsAPI } from "./quick-actions-api"
import {
  __resetQuickActionsForTesting,
  getQuickAction,
} from "@/lib/plugin/registries/quick-action-registry"
import { __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"

afterEach(() => {
  __resetQuickActionsForTesting()
  __resetCommandRegistryForTesting()
})

describe("createQuickActionsAPI", () => {
  it("registers through the registry when the capability is declared", () => {
    const api = createQuickActionsAPI({
      pluginId: "plug-a",
      capabilities: ["quick-action"],
    })

    const dispose = api.register({ id: "go", title: "Go", run: () => {} })

    expect(getQuickAction("plug-a:go")).toBeDefined()
    dispose()
    expect(getQuickAction("plug-a:go")).toBeUndefined()
  })

  it("registerMany returns a disposer that drops every action", () => {
    const api = createQuickActionsAPI({
      pluginId: "plug-a",
      capabilities: ["quick-action"],
    })

    const dispose = api.registerMany([
      { id: "one", title: "One", run: () => {} },
      { id: "two", title: "Two", run: () => {} },
    ])

    expect(getQuickAction("plug-a:one")).toBeDefined()
    expect(getQuickAction("plug-a:two")).toBeDefined()
    dispose()
    expect(getQuickAction("plug-a:one")).toBeUndefined()
    expect(getQuickAction("plug-a:two")).toBeUndefined()
  })

  it("is a no-op without the quick-action capability", () => {
    const api = createQuickActionsAPI({ pluginId: "plug-a", capabilities: ["tools"] })

    const dispose = api.register({ id: "go", title: "Go", run: () => {} })
    const disposeMany = api.registerMany([{ id: "two", title: "Two", run: () => {} }])

    expect(getQuickAction("plug-a:go")).toBeUndefined()
    expect(getQuickAction("plug-a:two")).toBeUndefined()
    expect(() => {
      dispose()
      disposeMany()
    }).not.toThrow()
  })
})
