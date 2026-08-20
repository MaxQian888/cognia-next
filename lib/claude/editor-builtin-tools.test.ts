import type { ActiveEditorContext } from "@/lib/files/project-editor-bridge"
import {
  EDITOR_WRITE_TOOL_NAMES,
  READ_ACTIVE_EDITOR_TOOL_NAME,
  buildEditorBuiltinManifestEntries,
  buildEditorWriteManifestEntries,
  isEditorBuiltinTool,
  isEditorWriteTool,
  runEditorBuiltinTool,
  type EditorToolRunDeps,
} from "./editor-builtin-tools"

const activeEditor: ActiveEditorContext = {
  path: "/repo/src/a.ts",
  selection: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 9 },
  selectedText: "const x = 1",
  diagnostics: [{ message: "unused", severity: "warning", line: 3, column: 1 }],
  openEditors: ["/repo/src/a.ts", "/repo/src/b.ts"],
}

function deps(overrides: Partial<EditorToolRunDeps> = {}): EditorToolRunDeps {
  return {
    resolveRoot: jest.fn().mockResolvedValue("/repo"),
    readActive: jest.fn().mockResolvedValue(activeEditor),
    gate: jest.fn().mockReturnValue(true),
    ...overrides,
  }
}

const run = (d: EditorToolRunDeps) =>
  runEditorBuiltinTool(READ_ACTIVE_EDITOR_TOOL_NAME, {}, d, { sessionId: "s1" })

describe("editor-builtin-tools", () => {
  it("exposes exactly the read_active_editor manifest entry", () => {
    const entries = buildEditorBuiltinManifestEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe("read_active_editor")
    expect(entries[0].pluginId).toBe("cognia-editor-builtin")
    expect(isEditorBuiltinTool("read_active_editor")).toBe(true)
    expect(isEditorBuiltinTool("web_search")).toBe(false)
  })

  it("returns the full editor context when the PII gate passes", async () => {
    const result = await run(deps())
    expect(result).toEqual({ available: true, ...activeEditor })
  })

  it("withholds text-bearing fields when the PII gate trips", async () => {
    const result = (await run(deps({ gate: jest.fn().mockReturnValue(false) }))) as Record<
      string,
      unknown
    >
    expect(result.available).toBe(true)
    expect(result.redacted).toBe(true)
    // The non-sensitive shape survives…
    expect(result.selection).toEqual(activeEditor.selection)
    expect(result.openEditorCount).toBe(2)
    // …but nothing that could carry PII does.
    expect(result).not.toHaveProperty("selectedText")
    expect(result).not.toHaveProperty("diagnostics")
    expect(result).not.toHaveProperty("path")
    expect(result).not.toHaveProperty("openEditors")
  })

  it("reports unavailable when the session has no workspace", async () => {
    const result = (await run(deps({ resolveRoot: jest.fn().mockResolvedValue(null) }))) as Record<
      string,
      unknown
    >
    expect(result.available).toBe(false)
    expect(String(result.reason)).toContain("workspace")
  })

  it("reports unavailable when no editor is mounted for the root", async () => {
    // The bridge resolves to null rather than rejecting when nothing is mounted.
    const readActive = jest.fn().mockResolvedValue(null)
    const result = (await run(deps({ readActive }))) as Record<string, unknown>
    expect(result.available).toBe(false)
    expect(String(result.reason)).toContain("No project editor is open")
  })

  it("reports unavailable when the mounted engine's transport fails", async () => {
    // e.g. code-server's companion extension has not connected yet. Same
    // user-visible outcome as no editor at all — never a thrown tool call.
    const readActive = jest.fn().mockRejectedValue(new Error("not connected"))
    const result = (await run(deps({ readActive }))) as Record<string, unknown>
    expect(result.available).toBe(false)
    expect(String(result.reason)).toContain("No project editor is open")
  })

  it("describes itself without naming a single engine", async () => {
    // The tool used to advertise itself as Pro-IDE-only while reading
    // code-server directly, so it was permanently unavailable for every user
    // who never switched engines — even though Monaco could answer.
    const description = buildEditorBuiltinManifestEntries()[0].description
    expect(description).toContain("project editor")
    expect(description).not.toMatch(/^Read what the user is currently looking at in the Pro IDE/)
  })

  it("does not read the editor for an unknown tool name", async () => {
    const d = deps()
    const result = (await runEditorBuiltinTool("nope", {}, d, { sessionId: "s1" })) as Record<
      string,
      unknown
    >
    expect(result.available).toBe(false)
    expect(d.readActive).not.toHaveBeenCalled()
  })
})

// ── Pro IDE write tools (ADR-0088 Phase 3) ──────────────────────────────────

describe("editor write tools", () => {
  const open = jest.fn().mockResolvedValue(undefined)
  const reveal = jest.fn().mockResolvedValue(undefined)
  const showDiff = jest.fn().mockResolvedValue(undefined)
  const applyEdit = jest.fn().mockResolvedValue(undefined)
  const saveAll = jest.fn().mockResolvedValue({ saved: ["/repo/a.ts"], failed: [] })
  let boundRoot: string | null = "/repo"

  const deps = (): EditorToolRunDeps => ({
    resolveRoot: async () => "/repo",
    readActive: async () => null,
    gate: () => true,
    proIde: {
      resolveProIdeRoot: () => boundRoot,
      open,
      reveal,
      showDiff,
      applyEdit,
      saveAll,
    },
  })

  const run = (name: string, args: Record<string, unknown> = {}) =>
    runEditorBuiltinTool(name, args, deps(), { sessionId: "s1" }) as Promise<
      Record<string, unknown>
    >

  beforeEach(() => {
    jest.clearAllMocks()
    boundRoot = "/repo"
    saveAll.mockResolvedValue({ saved: ["/repo/a.ts"], failed: [] })
  })

  it("routes every write tool name to the write runner", () => {
    for (const name of EDITOR_WRITE_TOOL_NAMES) {
      expect(isEditorBuiltinTool(name)).toBe(true)
      expect(isEditorWriteTool(name)).toBe(true)
    }
    // The read stays outside the write set — it is engine-agnostic.
    expect(isEditorBuiltinTool("read_active_editor")).toBe(true)
    expect(isEditorWriteTool("read_active_editor")).toBe(false)
  })

  it("opens a relative path against the bound workspace", async () => {
    const r = await run("open_in_editor", { path: "src/a.ts", line: 12 })
    expect(open).toHaveBeenCalledWith("/repo", "/repo/src/a.ts", 12, undefined)
    expect(r).toMatchObject({ available: true, opened: "/repo/src/a.ts" })
  })

  it("leaves an absolute path alone", async () => {
    await run("open_in_editor", { path: "/tmp/x.ts" })
    expect(open).toHaveBeenCalledWith("/repo", "/tmp/x.ts", undefined, undefined)
  })

  it("ignores a non-positive line rather than forwarding it", async () => {
    await run("open_in_editor", { path: "a.ts", line: 0 })
    expect(open).toHaveBeenCalledWith("/repo", "/repo/a.ts", undefined, undefined)
  })

  it("reveals a path", async () => {
    const r = await run("reveal_in_editor", { path: "src" })
    expect(reveal).toHaveBeenCalledWith("/repo", "/repo/src")
    expect(r).toMatchObject({ available: true, revealed: "/repo/src" })
  })

  it("tells the model explicitly that a diff did not write anything", async () => {
    // Left implicit, the model assumes the change landed and moves on.
    const r = await run("show_editor_diff", { path: "a.ts", content: "next", title: "Fix" })
    expect(showDiff).toHaveBeenCalledWith("/repo", "/repo/a.ts", "next", "Fix")
    expect(String(r.note)).toMatch(/Nothing was written to disk/)
  })

  it("accepts an empty diff proposal but not an absent one", async () => {
    await run("show_editor_diff", { path: "a.ts", content: "" })
    expect(showDiff).toHaveBeenCalledWith("/repo", "/repo/a.ts", "", undefined)

    const r = await run("show_editor_diff", { path: "a.ts" })
    expect(r.available).toBe(false)
    expect(String(r.reason)).toMatch(/requires a string "content"/)
  })

  it("reflects an already-written file", async () => {
    const r = await run("apply_editor_edit", { path: "a.ts", line: 3 })
    expect(applyEdit).toHaveBeenCalledWith("/repo", "/repo/a.ts", 3, undefined)
    expect(r).toMatchObject({ available: true, reflected: "/repo/a.ts" })
  })

  it("saves every dirty buffer, or just one", async () => {
    await run("save_editor_buffers", {})
    expect(saveAll).toHaveBeenCalledWith("/repo", undefined)

    await run("save_editor_buffers", { path: "a.ts" })
    expect(saveAll).toHaveBeenLastCalledWith("/repo", "/repo/a.ts")
  })

  it("reports a partial flush as data instead of failing", async () => {
    saveAll.mockResolvedValueOnce({ saved: [], failed: ["/repo/locked.ts"] })
    const r = await run("save_editor_buffers", {})
    expect(r).toMatchObject({ available: true, failed: ["/repo/locked.ts"] })
  })

  describe("degradation", () => {
    it("tells the model to fall back to chat when no workspace is bound", async () => {
      boundRoot = null
      const r = await run("open_in_editor", { path: "a.ts" })
      expect(r.available).toBe(false)
      expect(String(r.reason)).toMatch(/No Pro IDE workspace is open/)
      expect(open).not.toHaveBeenCalled()
    })

    it("reports unavailability rather than crashing when the deps are absent", async () => {
      // Surfaced only where `pro-ide` is a capability, so this is a caller bug —
      // it must still read as a tool result, not a thrown turn-ender.
      const r = (await runEditorBuiltinTool(
        "open_in_editor",
        { path: "a.ts" },
        { resolveRoot: async () => "/repo", readActive: async () => null, gate: () => true },
        { sessionId: "s1" }
      )) as Record<string, unknown>
      expect(r.available).toBe(false)
      expect(String(r.reason)).toMatch(/not available on this device/)
    })

    it("rejects a missing path before reaching the backend", async () => {
      const r = await run("reveal_in_editor", {})
      expect(r.available).toBe(false)
      expect(reveal).not.toHaveBeenCalled()
    })

    it("turns a backend rejection into a readable reason", async () => {
      open.mockRejectedValueOnce(new Error("no extension connected"))
      const r = await run("open_in_editor", { path: "a.ts" })
      expect(r.available).toBe(false)
      expect(String(r.reason)).toMatch(/no extension connected/)
    })
  })

  it("surfaces one manifest entry per write tool, with required args declared", () => {
    const entries = buildEditorWriteManifestEntries()
    expect(entries.map((e) => e.name)).toEqual([...EDITOR_WRITE_TOOL_NAMES])
    const byName = new Map(entries.map((e) => [e.name, e]))
    const required = (n: string) =>
      (byName.get(n)!.jsonSchema as { required?: string[] }).required ?? []
    expect(required("open_in_editor")).toEqual(["path"])
    expect(required("show_editor_diff")).toEqual(["path", "content"])
    // saveAll's `path` is the optional narrowing filter, not a target.
    expect(required("save_editor_buffers")).toEqual([])
  })
})
