import type { ActiveEditorContext } from "@/lib/files/project-editor-bridge"
import {
  READ_ACTIVE_EDITOR_TOOL_NAME,
  buildEditorBuiltinManifestEntries,
  isEditorBuiltinTool,
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
