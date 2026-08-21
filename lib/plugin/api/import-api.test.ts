import { readFileSync } from "node:fs"
import path from "node:path"

import {
  createImportAPI,
  clearCustomImporters,
  clearCustomImportersByPlugin,
  getCustomImporterOwnersForFile,
} from "./import-api"
import { getSessionSource } from "@/lib/session-import/registry"
import type { AgentSessionSourceAdapter } from "@/lib/session-import/types"
import {
  __resetDynamicImportersForTesting,
  detectFormat,
  getImporterLabel,
  importChatExport,
  unregisterImportersByPlugin,
} from "@/lib/data/import-registry"

jest.mock("../core/logger", () => ({
  createPluginSystemLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}))

function fakeSessionSource(id: string): AgentSessionSourceAdapter {
  return {
    id,
    displayName: id,
    labelKey: id,
    acceptedExtensions: [".jsonl"],
    scanRoots: () => [],
    detect: () => "no",
    listSessions: async () => [],
    parseSession: async () => ({
      session: { id, title: "", createdAt: 0, updatedAt: 0 } as never,
      messages: [],
    }),
  }
}

describe("createImportAPI", () => {
  beforeEach(() => clearCustomImporters())

  it("registers an importer namespaced by plugin id and lists it", () => {
    const api = createImportAPI("p1")
    api.registerImporter({
      id: "md",
      name: "Markdown",
      description: "md",
      format: "markdown",
      extensions: ["md"],
      import: () => ({ success: true }),
    })
    const all = api.getCustomImporters()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe("p1:md")
  })

  it("disposer unregisters the importer", () => {
    const api = createImportAPI("p1")
    const dispose = api.registerImporter({
      id: "md",
      name: "Markdown",
      description: "md",
      format: "markdown",
      extensions: ["md"],
      import: () => ({ success: true }),
    })
    dispose()
    expect(api.getCustomImporters()).toHaveLength(0)
  })

  it("finds and deduplicates importer owners by extension or MIME type", () => {
    const api = createImportAPI("office")
    api.registerImporter({
      id: "xlsx-primary",
      name: "Excel",
      description: "xlsx",
      format: "xlsx",
      extensions: ["xlsx"],
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      import: () => ({ success: true }),
    })
    api.registerImporter({
      id: "xlsx-secondary",
      name: "Excel fallback",
      description: "xlsx",
      format: "xlsx-fallback",
      extensions: [".xlsx"],
      import: () => ({ success: true }),
    })

    expect(getCustomImporterOwnersForFile("REPORT.XLSX")).toEqual(["office"])
    expect(
      getCustomImporterOwnersForFile(
        "attachment",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
    ).toEqual(["office"])
  })

  it("importContent dispatches by the plugin-owned registration id", async () => {
    const api = createImportAPI("p1")
    api.registerImporter({
      id: "md",
      name: "Markdown",
      description: "md",
      format: "markdown",
      extensions: ["md"],
      import: (src) => ({ success: true, data: String(src.content).toUpperCase() }),
    })
    const result = await api.importContent({ content: "hi" }, "md")
    expect(result).toEqual({ success: true, data: "HI" })
  })

  it("importContent returns an error when no importer matches the format", async () => {
    const api = createImportAPI("p1")
    const result = await api.importContent({ content: "x" }, "nope")
    expect(result.success).toBe(false)
    expect(result.error).toContain("nope")
  })

  it("importContent surfaces a throwing importer as a failure result", async () => {
    const api = createImportAPI("p1")
    api.registerImporter({
      id: "boom",
      name: "Boom",
      description: "throws",
      format: "boom",
      extensions: ["x"],
      import: () => {
        throw new Error("kaboom")
      },
    })
    const result = await api.importContent({ content: "x" }, "boom")
    expect(result).toEqual({ success: false, error: "kaboom" })
  })

  it("registers a plugin session source (namespaced) and disposes it", () => {
    const api = createImportAPI("acme")
    const dispose = api.registerSessionSource(fakeSessionSource("opencode-fork"))
    expect(getSessionSource("acme:opencode-fork")).toBeDefined()
    dispose()
    expect(getSessionSource("acme:opencode-fork")).toBeUndefined()
  })

  describe("registerChatImporter (§A-4)", () => {
    afterEach(() => __resetDynamicImportersForTesting())

    const slackImporter = {
      format: "slack",
      label: "Slack",
      detect: (d: unknown): d is { slack: unknown[] } =>
        !!d && typeof d === "object" && Array.isArray((d as { slack?: unknown }).slack),
      parse: async () => [],
    }

    it("makes the plugin format detectable, namespaced by plugin id", () => {
      const api = createImportAPI("acme")
      expect(detectFormat({ slack: [] })).toBe("unknown")

      api.registerChatImporter(slackImporter)

      expect(detectFormat({ slack: [] })).toBe("acme:slack")
      expect(getImporterLabel("acme:slack")).toBe("Slack")
    })

    it("disposer removes the importer again", () => {
      const api = createImportAPI("acme")
      const dispose = api.registerChatImporter(slackImporter)
      expect(detectFormat({ slack: [] })).toBe("acme:slack")

      dispose()

      expect(detectFormat({ slack: [] })).toBe("unknown")
      expect(getImporterLabel("acme:slack")).toBeUndefined()
    })

    it("cannot shadow a built-in format even when it detects the same payload", () => {
      const api = createImportAPI("evil")
      // A greedy importer that claims everything must still lose to ChatGPT,
      // because the static registry is consulted first.
      api.registerChatImporter({
        format: "chatgpt",
        label: "Not ChatGPT",
        detect: (d: unknown): d is unknown => !!d,
        parse: async () => [],
      })
      const chatgptExport = [{ title: "t", mapping: {} }]
      expect(detectFormat(chatgptExport)).toBe("chatgpt")
    })

    it("parses through the plugin importer", async () => {
      const api = createImportAPI("acme")
      const session = { id: "s1", title: "hi", createdAt: 0, updatedAt: 0 }
      api.registerChatImporter({
        ...slackImporter,
        parse: async () => [{ session: session as never, messages: [] }],
      })
      const result = await importChatExport({ slack: [] })
      expect(result.format).toBe("acme:slack")
      expect(result.conversations).toHaveLength(1)
      expect(result.conversations[0].session.id).toBe("s1")
    })

    it("keeps two plugins' formats separate", () => {
      createImportAPI("a").registerChatImporter({ ...slackImporter, format: "x", label: "A" })
      createImportAPI("b").registerChatImporter({ ...slackImporter, format: "x", label: "B" })
      expect(getImporterLabel("a:x")).toBe("A")
      expect(getImporterLabel("b:x")).toBe("B")
    })
  })

  it("isolates importers across plugins by namespacing", () => {
    const a = createImportAPI("a")
    const b = createImportAPI("b")
    a.registerImporter({
      id: "same",
      name: "A",
      description: "a",
      format: "fa",
      extensions: ["x"],
      import: () => ({ success: true }),
    })
    b.registerImporter({
      id: "same",
      name: "B",
      description: "b",
      format: "fb",
      extensions: ["x"],
      import: () => ({ success: true }),
    })
    expect(
      a
        .getCustomImporters()
        .map((i) => i.id)
        .sort()
    ).toEqual(["a:same"])
  })
})

describe("plugin disable teardown", () => {
  beforeEach(() => {
    clearCustomImporters()
    __resetDynamicImportersForTesting()
  })

  it("clearCustomImportersByPlugin drops only that plugin's importers", () => {
    const a = createImportAPI("a")
    const b = createImportAPI("b")
    for (const [api, id] of [
      [a, "one"],
      [a, "two"],
      [b, "one"],
    ] as const) {
      api.registerImporter({
        id,
        name: id,
        description: id,
        format: id,
        extensions: ["zip"],
        import: () => ({ success: true }),
      })
    }

    expect(clearCustomImportersByPlugin("a")).toBe(2)
    expect(a.getCustomImporters()).toEqual([])
    expect(b.getCustomImporters().map((i) => i.id)).toEqual(["b:one"])
    // Idempotent — a second disable pass must not throw or double-count.
    expect(clearCustomImportersByPlugin("a")).toBe(0)
  })

  it("a swept plugin no longer claims attachment bytes", () => {
    const api = createImportAPI("leaky")
    api.registerImporter({
      id: "slack",
      name: "Slack export",
      description: "slack",
      format: "slack",
      extensions: ["zip"],
      mimeType: "application/zip",
      import: () => ({ success: true }),
    })
    expect(getCustomImporterOwnersForFile("export.zip", "application/zip")).toEqual(["leaky"])

    clearCustomImportersByPlugin("leaky")
    // The real consequence of the missing sweep: `lib/chat/attachments/dispatch.ts`
    // authorizes the raw bytes of a matching attachment to every owner this
    // returns, so a disabled plugin must disappear from it.
    expect(getCustomImporterOwnersForFile("export.zip", "application/zip")).toEqual([])
  })

  it("a swept plugin's chat importer stops being detected", async () => {
    const api = createImportAPI("acme")
    api.registerChatImporter<{ widget: true }>({
      format: "widget",
      label: "Widget export",
      detect: (data: unknown): data is { widget: true } =>
        (data as { widget?: boolean })?.widget === true,
      parse: async () => [],
    })
    expect(detectFormat({ widget: true })).toBe("acme:widget")

    unregisterImportersByPlugin("acme")
    expect(detectFormat({ widget: true })).toBe("unknown")
    await expect(importChatExport({ widget: true })).rejects.toThrow(/recognize/i)
  })

  it("the plugin manager's disable path calls both sweeps", () => {
    // The functions were always correct; what was missing for both was the CALL
    // SITE. Pin it, because nothing else fails when a disable sweep is dropped.
    const manager = readFileSync(path.join(process.cwd(), "lib/plugin/core/manager.ts"), "utf8")
    expect(manager).toContain("unregisterImportersByPlugin(pluginId)")
    expect(manager).toContain("clearCustomImportersByPlugin(pluginId)")
  })
})
