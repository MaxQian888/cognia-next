/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { act } from "react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockRows: PluginRow[] | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows ?? [])),
}))

import {
  buildView,
  countLibrarySubFilters,
  isPluginRowErrored,
  pluginRowMatchesStatus,
  usePlugins,
} from "./use-plugins"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

function row(over: Partial<PluginRow>): PluginRow {
  return {
    id: "p_" + (over.name ?? "x"),
    name: over.name ?? "x",
    version: over.version ?? "1.0.0",
    status: over.status ?? "enabled",
    source: over.source ?? "builtin",
    type: over.type ?? "frontend",
    enabled: over.enabled ?? true,
    lifecycle: over.lifecycle,
    capabilities: over.capabilities ?? ["tools"],
    path: over.path ?? "builtin://x",
    manifest: over.manifest ?? { id: "p_" + (over.name ?? "x") },
    config: over.config,
    error: over.error,
    lastUsedAt: over.lastUsedAt,
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
  }
}

beforeEach(() => {
  mockRows = undefined
  usePluginsStore.setState({
    filters: DEFAULT_PLUGIN_FILTERS,
    selection: new Set(),
    detailPluginId: null,
    filterSheetOpen: false,
    importStaging: null,
    deleteTarget: null,
    permissionReviewTarget: null,
    conflictDialogTarget: null,
  })
})

describe("usePlugins", () => {
  it("reports loading=true while rows are undefined", () => {
    mockRows = undefined
    const { result } = renderHook(() => usePlugins())
    expect(result.current.loading).toBe(true)
    expect(result.current.all).toEqual([])
    expect(result.current.totals.total).toBe(0)
  })

  it("aggregates totals and per-source / per-capability counts", () => {
    mockRows = [
      row({ name: "alpha", source: "builtin", capabilities: ["tools", "commands"] }),
      row({
        name: "beta",
        source: "marketplace",
        status: "error",
        enabled: false,
        capabilities: ["themes"],
      }),
      row({
        name: "gamma",
        source: "marketplace",
        status: "loading",
        capabilities: ["tools"],
      }),
    ]
    const { result } = renderHook(() => usePlugins())
    expect(result.current.totals).toEqual({
      total: 3,
      enabled: 2,
      errored: 1,
      loading: 1,
      updateAvailable: 0,
    })
    expect(result.current.countsBySource).toEqual({ builtin: 1, marketplace: 2 })
    expect(result.current.countsByCapability.tools).toBe(2)
    expect(result.current.countsByCapability.commands).toBe(1)
    expect(result.current.countsByCapability.themes).toBe(1)
  })

  it("filters by capability", () => {
    mockRows = [
      row({ name: "a", capabilities: ["tools"] }),
      row({ name: "b", capabilities: ["themes"] }),
    ]
    act(() => usePluginsStore.getState().setFilters({ capability: "themes" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0]?.name).toBe("b")
  })

  it("filters by required permission via manifest.permissions", () => {
    mockRows = [
      row({
        name: "a",
        manifest: { id: "a", permissions: ["clipboard:read"] },
      }),
      row({ name: "b", manifest: { id: "b", permissions: ["network:fetch"] } }),
    ]
    act(() => usePluginsStore.getState().setFilters({ permission: "network:fetch" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0]?.name).toBe("b")
  })

  it("filters by signed-only and hasUpdate", () => {
    mockRows = [
      row({ name: "a", manifest: { id: "a", signature: { verified: true } } }),
      row({ name: "b", manifest: { id: "b" } }),
      row({ name: "c", manifest: { id: "c", updateAvailable: true } }),
    ]
    act(() => usePluginsStore.getState().setFilters({ signedOnly: true }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["a"])

    act(() => usePluginsStore.getState().setFilters({ signedOnly: false, hasUpdate: true }))
    const { result: result2 } = renderHook(() => usePlugins())
    expect(result2.current.filtered.map((r) => r.name)).toEqual(["c"])
  })

  it("text query matches name / id / manifest.description", () => {
    mockRows = [
      row({
        name: "Alpha",
        manifest: { id: "alpha", description: "first plugin" },
      }),
      row({
        name: "Beta",
        manifest: { id: "beta", description: "another extension" },
      }),
    ]
    act(() => usePluginsStore.getState().setFilters({ query: "First" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0]?.name).toBe("Alpha")
  })

  it("sort by name (default)", () => {
    mockRows = [row({ name: "Charlie" }), row({ name: "Alpha" }), row({ name: "Bravo" })]
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("sort by updated descending", () => {
    mockRows = [row({ name: "old", updatedAt: 1 }), row({ name: "new", updatedAt: 100 })]
    act(() => usePluginsStore.getState().setFilters({ sort: "updated" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["new", "old"])
  })

  it("sort by rating descending", () => {
    mockRows = [
      row({ name: "low", manifest: { id: "low", rating: 2 } }),
      row({ name: "high", manifest: { id: "high", rating: 5 } }),
    ]
    act(() => usePluginsStore.getState().setFilters({ sort: "rating" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["high", "low"])
  })
})

describe("search and tag reach", () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: "acme.widgets",
      name: "Widgets",
      version: "1.0.0",
      status: "enabled",
      source: "marketplace",
      type: "frontend",
      enabled: true,
      capabilities: [],
      path: "/p",
      manifest: { id: "acme.widgets" },
      createdAt: 0,
      updatedAt: 0,
      ...over,
    }) as never

  const filters = (over: Record<string, unknown>) => ({
    ...DEFAULT_PLUGIN_FILTERS,
    ...over,
  })

  // Name / description / id used to be the whole of it, so a user who
  // remembered the publisher or an advertised keyword could not find the
  // plugin by either.
  it("matches on the author, in both manifest shapes", () => {
    const objectForm = row({ manifest: { id: "a", author: { name: "Acme Labs" } } })
    const stringForm = row({ id: "b", manifest: { id: "b", author: "Acme Labs" } })
    const view = buildView([objectForm, stringForm], filters({ query: "acme lab" }))
    expect(view.filtered).toHaveLength(2)
  })

  it("matches on a manifest keyword", () => {
    const view = buildView(
      [row({ manifest: { id: "a", keywords: ["Screenshot", "OCR"] } })],
      filters({ query: "ocr" })
    )
    expect(view.filtered).toHaveLength(1)
  })

  it("still rejects a term that appears nowhere", () => {
    const view = buildView([row()], filters({ query: "nothing-matches-this" }))
    expect(view.filtered).toHaveLength(0)
  })

  // `PluginFilters.tag` was declared, defaulted to null, and applied by
  // nothing. It is what a keyword chip writes.
  it("narrows by the tag facet", () => {
    const tagged = row({ id: "a", manifest: { id: "a", keywords: ["ocr"] } })
    const untagged = row({ id: "b", manifest: { id: "b", keywords: ["chat"] } })
    const view = buildView([tagged, untagged], filters({ tag: "OCR" }))
    expect(view.filtered.map((r) => r.id)).toEqual(["a"])
  })

  it("ignores the tag facet when it is null", () => {
    const view = buildView([row(), row({ id: "b" })], filters({ tag: null }))
    expect(view.filtered).toHaveLength(2)
  })
})

describe("localized names", () => {
  // Rows show their manifest's `nameKey` text in the UI language, so search
  // and the name sort have to see the same text the user does.
  const localizedRow = (name: string, zhName: string) =>
    row({
      name,
      manifest: {
        id: "p_" + name,
        nameKey: "manifest.name",
        i18n: {
          locales: {
            en: { "manifest.name": name },
            "zh-CN": { "manifest.name": zhName },
          },
        },
      } as never,
    })

  const rows = () => [
    localizedRow("Clipboard History", "剪贴板历史"),
    localizedRow("Browser Tools", "浏览器工具"),
    localizedRow("Agent Eval", "Agent 评测"),
  ]

  it("finds a plugin by the name shown in the UI language", () => {
    const view = buildView(rows(), { ...DEFAULT_PLUGIN_FILTERS, query: "剪贴板" }, "zh-CN")
    expect(view.filtered.map((r) => r.name)).toEqual(["Clipboard History"])
  })

  it("still finds it by the manifest's own name", () => {
    const view = buildView(rows(), { ...DEFAULT_PLUGIN_FILTERS, query: "clipboard" }, "zh-CN")
    expect(view.filtered.map((r) => r.name)).toEqual(["Clipboard History"])
  })

  it("sorts by the shown name with the locale's collation", () => {
    const byShown: Record<string, string> = {
      剪贴板历史: "Clipboard History",
      浏览器工具: "Browser Tools",
      "Agent 评测": "Agent Eval",
    }
    const expected = Object.keys(byShown)
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .map((shown) => byShown[shown])
    const zh = buildView(rows(), DEFAULT_PLUGIN_FILTERS, "zh-CN").filtered.map((r) => r.name)
    expect(zh).toEqual(expected)
    // …and the English order is still alphabetical by the English name.
    expect(buildView(rows(), DEFAULT_PLUGIN_FILTERS).filtered.map((r) => r.name)).toEqual([
      "Agent Eval",
      "Browser Tools",
      "Clipboard History",
    ])
  })
})

describe("status meaning: enabled / disabled / error", () => {
  // The manager writes `row.status` at discovery and keeps the live status in
  // its own store; enabling writes `enabled` and the lifecycle. These rows
  // reproduce that shape: status and enabled disagree on purpose.
  const lifecycle = (actual: "active" | "error" | "dirty" | "inactive") => ({
    intent: "enabled" as const,
    actual,
    revision: 1,
    updatedAt: 0,
  })
  const fixture = () => [
    row({ name: "on", status: "installed", enabled: true, lifecycle: lifecycle("active") }),
    row({ name: "off", status: "enabled", enabled: false }),
    row({ name: "failed", status: "installed", enabled: true, lifecycle: lifecycle("error") }),
    row({ name: "stuck", status: "installed", enabled: false, lifecycle: lifecycle("dirty") }),
    row({ name: "legacy", status: "error", enabled: false }),
  ]

  it("'enabled' follows row.enabled, not row.status", () => {
    const view = buildView(fixture(), { ...DEFAULT_PLUGIN_FILTERS, status: "enabled" })
    expect(view.filtered.map((r) => r.name).sort()).toEqual(["failed", "on"])
  })

  it("'disabled' is the complement of 'enabled'", () => {
    const view = buildView(fixture(), { ...DEFAULT_PLUGIN_FILTERS, status: "disabled" })
    expect(view.filtered.map((r) => r.name).sort()).toEqual(["legacy", "off", "stuck"])
  })

  it("'error' covers a lifecycle error, a dirty teardown and a legacy error status", () => {
    const view = buildView(fixture(), { ...DEFAULT_PLUGIN_FILTERS, status: "error" })
    expect(view.filtered.map((r) => r.name).sort()).toEqual(["failed", "legacy", "stuck"])
  })

  it("totals, quick-filter counts and the filter agree", () => {
    const rows = fixture()
    const view = buildView(rows, DEFAULT_PLUGIN_FILTERS)
    const counts = countLibrarySubFilters(rows)
    const enabledShown = buildView(rows, { ...DEFAULT_PLUGIN_FILTERS, status: "enabled" })
    const erroredShown = buildView(rows, { ...DEFAULT_PLUGIN_FILTERS, status: "error" })
    expect(view.totals.enabled).toBe(counts.enabled)
    expect(enabledShown.filtered).toHaveLength(counts.enabled)
    expect(view.totals.errored).toBe(counts.errored)
    expect(erroredShown.filtered).toHaveLength(counts.errored)
  })

  it("matches any other status against row.status verbatim", () => {
    const [on] = fixture()
    expect(pluginRowMatchesStatus(on, "installed")).toBe(true)
    expect(pluginRowMatchesStatus(on, "loading")).toBe(false)
    expect(pluginRowMatchesStatus(on, "all")).toBe(true)
  })

  it("an active lifecycle is not an error", () => {
    expect(isPluginRowErrored({ status: "installed", lifecycle: lifecycle("active") })).toBe(false)
    expect(isPluginRowErrored({ status: "installed" })).toBe(false)
  })
})

describe("countLibrarySubFilters", () => {
  it("counts 'configurable' with pluginExposesConfig, as the filter does", () => {
    const rows = [
      row({ name: "schema", manifest: { configSchema: { properties: { a: {} } } } }),
      row({ name: "empty-schema", manifest: { configSchema: { type: "object" } } }),
      row({ name: "component", manifest: { configComponent: { entry: "./c.js" } } }),
      row({ name: "none" }),
    ]
    expect(countLibrarySubFilters(rows).configurable).toBe(2)
    const shown = buildView(rows, { ...DEFAULT_PLUGIN_FILTERS, configurable: true })
    expect(shown.filtered.map((r) => r.name).sort()).toEqual(["component", "schema"])
  })

  it("counts updates from manifest.updateAvailable", () => {
    const rows = [row({ name: "u", manifest: { updateAvailable: true } }), row({ name: "n" })]
    expect(countLibrarySubFilters(rows)).toMatchObject({ all: 2, updates: 1 })
  })
})
