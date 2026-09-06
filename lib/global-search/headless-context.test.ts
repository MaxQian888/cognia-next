/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  __resetHeadlessSearchProvidersForTesting,
  buildHeadlessSearchContext,
  WORKFLOW_SEARCHABLE_KINDS,
} from "./headless-context"
import { listGlobalSearchProviders } from "./registry"

beforeEach(async () => {
  __resetHeadlessSearchProvidersForTesting()
  const { getDb } = await import("@/lib/db/schema")
  await getDb().sessions.clear()
  await getDb().projects.clear()
})

describe("buildHeadlessSearchContext", () => {
  it("takes the workspace from the caller and never from a store", async () => {
    // A scheduled or headless run has no open panel, so a store read here is
    // not a fallback, it is an empty value dressed up as one.
    const ctx = await buildHeadlessSearchContext({ activeProjectId: "p_run" })
    expect(ctx.activeProjectId).toBe("p_run")
    expect(ctx.activeSessionId).toBeNull()
  })

  it("resolves a real message key through the aggregate bundle", async () => {
    const ctx = await buildHeadlessSearchContext({})
    // Not a stub translator: providers build their labels from these keys, so
    // a missing bundle would show raw keys in a step output.
    const label = ctx.t("globalSearch.kinds.session")
    expect(typeof label).toBe("string")
    expect(label.length).toBeGreaterThan(0)
    expect(label).not.toBe("globalSearch.kinds.session")
  })

  it("filters sessions for the search channel", async () => {
    const { getDb } = await import("@/lib/db/schema")
    await getDb().sessions.bulkPut([
      { id: "a", title: "A", createdAt: 1, updatedAt: 1 },
      { id: "b", title: "B", createdAt: 1, updatedAt: 1, visibility: "embedded" },
    ] as never)
    const ctx = await buildHeadlessSearchContext({})
    expect(ctx.sessions.map((s) => s.id)).toEqual(["a"])
  })

  it("carries the active workspace's capability overlay and nobody else's", async () => {
    const { getDb } = await import("@/lib/db/schema")
    await getDb().projects.bulkPut([
      { id: "p1", name: "One", createdAt: 1, updatedAt: 1, capabilityOverlay: { skill: {} } },
      { id: "p2", name: "Two", createdAt: 1, updatedAt: 1, capabilityOverlay: { mcpServer: {} } },
    ] as never)
    const ctx = await buildHeadlessSearchContext({ activeProjectId: "p2" })
    expect(ctx.capabilityOverlay).toEqual({ mcpServer: {} })
    expect(ctx.workspaces).toHaveLength(2)
  })

  it("answers every shell fact conservatively rather than optimistically", async () => {
    // Each of these belongs to a kind the workflow surface excludes. Inventing
    // an answer would let a provider gate on a fact a graph cannot check.
    const ctx = await buildHeadlessSearchContext({})
    expect(ctx.host.reachableSettingsSections.size).toBe(0)
    expect(ctx.host.recorderAvailable).toBe(false)
    expect(ctx.host.hasApiKey).toBe(false)
    expect(ctx.host.pluginQuickActions).toEqual([])
    expect(ctx.host.workbenchPanels).toEqual([])
    expect(ctx.runtimeSnapshot).toEqual({
      target: null,
      vaultState: "unavailable",
      connectionState: "offline",
    })
  })

  it("registers the built-in providers once, outside React", async () => {
    await buildHeadlessSearchContext({})
    const first = listGlobalSearchProviders().length
    expect(first).toBeGreaterThan(10)
    await buildHeadlessSearchContext({})
    expect(listGlobalSearchProviders()).toHaveLength(first)
  })
})

describe("WORKFLOW_SEARCHABLE_KINDS", () => {
  it("excludes every kind whose items carry a function or a component", () => {
    // `action`, `navigation`, `settings`, `workbench-panel` and `plugin-action`
    // produce `{ type: "callback", run }` actions and `{ lucide }` icons.
    // Neither survives a step output nor means anything to a downstream node.
    for (const excluded of [
      "action",
      "navigation",
      "settings",
      "workbench-panel",
      "plugin-action",
    ]) {
      expect(WORKFLOW_SEARCHABLE_KINDS).not.toContain(excluded)
    }
  })

  it("keeps the entity kinds a graph can act on", () => {
    for (const kind of ["session", "message", "memory", "workflow", "issue"]) {
      expect(WORKFLOW_SEARCHABLE_KINDS).toContain(kind)
    }
  })
})
