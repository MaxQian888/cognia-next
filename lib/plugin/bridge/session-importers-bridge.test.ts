import {
  registerSessionImportersForPlugin,
  unregisterSessionImportersForPlugin,
} from "./session-importers-bridge"
import {
  getSessionSources,
  __resetDynamicSessionSourcesForTesting,
  type AgentSessionSourceAdapter,
} from "@/lib/session-import"
import type { PluginManifest } from "@/types/plugin/plugin"

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: { manager: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } },
}))

function fakeAdapter(id: string): AgentSessionSourceAdapter {
  return {
    id,
    displayName: id,
    labelKey: id,
    acceptedExtensions: [".json"],
    scanRoots: () => [],
    detect: () => "no",
    listSessions: async () => [],
    parseSession: async () => ({
      session: { id, title: "t", createdAt: 0, updatedAt: 0 } as never,
      messages: [],
    }),
  }
}

function manifest(defs: unknown[]): PluginManifest {
  return { id: "plug", sessionImporters: defs } as unknown as PluginManifest
}

const okImporter = async () => ({ createImporter: () => fakeAdapter("cursor") })

afterEach(() => {
  __resetDynamicSessionSourcesForTesting()
  jest.clearAllMocks()
})

describe("registerSessionImportersForPlugin", () => {
  it("registers a valid importer under the namespaced id", async () => {
    const result = await registerSessionImportersForPlugin(
      manifest([
        { id: "cursor", label: "Cursor", entry: "src/cursor.ts", export: "createImporter" },
      ]),
      "/plugins/plug",
      { importer: okImporter }
    )
    expect(result.registered).toBe(1)
    expect(result.errors).toEqual([])
    expect(getSessionSources().some((s) => s.id === "plug:cursor")).toBe(true)
  })

  it("returns early with no work when there are no defs", async () => {
    const result = await registerSessionImportersForPlugin(manifest([]), "/plugins/plug", {
      importer: okImporter,
    })
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  it.each([
    [{ label: "X", entry: "e.ts", export: "f" }, "id is required"],
    [{ id: "x", entry: "e.ts", export: "f" }, "label is required"],
    [{ id: "x", label: "X", export: "f" }, "entry is required"],
    [{ id: "x", label: "X", entry: "e.ts" }, "export is required"],
  ])("collects an error for an invalid def (%o)", async (def, message) => {
    const result = await registerSessionImportersForPlugin(manifest([def]), "/plugins/plug", {
      importer: okImporter,
    })
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain(message)
  })

  it("falls back to the default importer when none is injected (real import fails → error)", async () => {
    const result = await registerSessionImportersForPlugin(
      manifest([{ id: "x", label: "X", entry: "src/does-not-exist.ts", export: "f" }]),
      "/plugins/plug"
      // no importer → DEFAULT_IMPORTER runs a real import() which rejects
    )
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
  })

  it("errors when the export is not a factory function", async () => {
    const result = await registerSessionImportersForPlugin(
      manifest([{ id: "x", label: "X", entry: "e.ts", export: "notThere" }]),
      "/plugins/plug",
      { importer: async () => ({ notThere: 42 }) }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("does not export a factory")
  })

  it("errors when the factory returns a non-adapter", async () => {
    const result = await registerSessionImportersForPlugin(
      manifest([{ id: "x", label: "X", entry: "e.ts", export: "make" }]),
      "/plugins/plug",
      { importer: async () => ({ make: () => ({ id: "x" }) }) }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("did not return a valid session source")
  })

  it("replaces cleanly on re-enable (clears prior entries first)", async () => {
    const m = manifest([
      { id: "cursor", label: "Cursor", entry: "src/cursor.ts", export: "createImporter" },
    ])
    await registerSessionImportersForPlugin(m, "/plugins/plug", { importer: okImporter })
    await registerSessionImportersForPlugin(m, "/plugins/plug", { importer: okImporter })
    expect(getSessionSources().filter((s) => s.id === "plug:cursor")).toHaveLength(1)
  })
})

describe("unregisterSessionImportersForPlugin", () => {
  it("drops every source contributed by the plugin", async () => {
    await registerSessionImportersForPlugin(
      manifest([
        { id: "cursor", label: "Cursor", entry: "src/cursor.ts", export: "createImporter" },
      ]),
      "/plugins/plug",
      { importer: okImporter }
    )
    unregisterSessionImportersForPlugin("plug")
    expect(getSessionSources().some((s) => s.id === "plug:cursor")).toBe(false)
  })
})
