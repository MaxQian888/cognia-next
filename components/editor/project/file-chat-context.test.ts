import {
  buildFileContextSelection,
  buildFolderContextSelection,
  buildProblemContextSelection,
  buildProblemsContextSelection,
  FILE_SNAPSHOT_MAX_BYTES,
  PROBLEM_LIST_MAX_MARKERS,
  type FileContextChatDeps,
  type ProblemMarkerLike,
} from "./file-chat-context"
import type { WorkspaceEntry } from "@/lib/files/types"

const entry = (relPath: string, isDir = false): WorkspaceEntry => ({
  relPath,
  absolutePath: `/repo/${relPath}`,
  isDir,
  size: 10,
  mtimeMs: null,
})

function makeDeps(overrides: Partial<FileContextChatDeps> = {}): FileContextChatDeps {
  return {
    readFile: jest.fn(async () => "disk body\nline two\n"),
    listDir: jest.fn(async () => [entry("src/a.ts"), entry("src/nested", true)]),
    ...overrides,
  }
}

describe("buildFileContextSelection", () => {
  it("stages the live draft when the file is open", async () => {
    const deps = makeDeps()
    const sel = await buildFileContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      draftContent: "draft wins",
      deps,
    })
    expect(sel).toMatchObject({ kind: "file", relPath: "src/a.ts", title: "a.ts" })
    expect(sel.snapshot).toBe("draft wins")
    expect(deps.readFile).not.toHaveBeenCalled()
  })

  it("falls back to a disk read for closed files", async () => {
    const sel = await buildFileContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      deps: makeDeps(),
    })
    expect(sel.snapshot).toBe("disk body\nline two\n")
  })

  it("degrades to an empty body when the read fails — the path ref still helps", async () => {
    const deps = makeDeps({
      readFile: jest.fn(async () => {
        throw new Error("gone")
      }),
    })
    const sel = await buildFileContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      deps,
    })
    expect(sel.snapshot).toBe("")
  })

  it("narrows the snapshot to a line range", async () => {
    const sel = await buildFileContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      draftContent: "one\ntwo\nthree\nfour",
      range: { startLine: 2, endLine: 3 },
      deps: makeDeps(),
    })
    expect(sel.snapshot).toBe("two\nthree")
    expect(sel.range).toEqual({ startLine: 2, endLine: 3 })
  })

  it("prefers the editor's captured selection text over re-slicing", async () => {
    const sel = await buildFileContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      draftContent: "one\ntwo\nthree",
      range: { startLine: 1, endLine: 2 },
      selectedText: "e\ntw",
      deps: makeDeps(),
    })
    expect(sel.snapshot).toBe("e\ntw")
  })

  it("truncates whole-file snapshots past the cap", async () => {
    const sel = await buildFileContextSelection({
      rootPath: "/repo",
      relPath: "big.ts",
      draftContent: "x".repeat(FILE_SNAPSHOT_MAX_BYTES + 50),
      deps: makeDeps(),
    })
    expect(sel.snapshot.length).toBe(FILE_SNAPSHOT_MAX_BYTES + 2)
    expect(sel.snapshot.endsWith("…")).toBe(true)
  })
})

describe("buildFolderContextSelection", () => {
  it("stages a formatted child listing, dirs marked with /", async () => {
    const sel = await buildFolderContextSelection({
      rootPath: "/repo",
      relPath: "src",
      deps: makeDeps(),
    })
    expect(sel).toMatchObject({ kind: "file", relPath: "src", title: "src/" })
    expect(sel.snapshot).toContain("src/ (2 items)")
    expect(sel.snapshot).toContain("  a.ts")
    expect(sel.snapshot).toContain("  nested/")
  })

  it("still stages when the listing fails", async () => {
    const deps = makeDeps({
      listDir: jest.fn(async () => {
        throw new Error("nope")
      }),
    })
    const sel = await buildFolderContextSelection({ rootPath: "/repo", relPath: "src", deps })
    expect(sel.snapshot).toContain("src/ (0 items)")
  })
})

describe("buildProblemContextSelection", () => {
  const marker = {
    message: "Cannot find module './x'",
    kind: "error",
    startLineNumber: 2,
    startColumn: 5,
    endLineNumber: 2,
    endColumn: 20,
    source: "typescript",
  }

  it("pairs the diagnostic with the offending line", async () => {
    const sel = await buildProblemContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      marker,
      draftContent: "one\nimport x from './x'\nthree",
      deps: makeDeps(),
    })
    expect(sel.title).toBe("a.ts:2")
    expect(sel.snapshot).toBe(
      "src/a.ts:2:5 — error: Cannot find module './x' (typescript)\n\n2 | import x from './x'"
    )
    expect(sel.range).toEqual({ startLine: 2, endLine: 2 })
  })

  it("omits the code line when the file cannot be read", async () => {
    const deps = makeDeps({
      readFile: jest.fn(async () => {
        throw new Error("gone")
      }),
    })
    const sel = await buildProblemContextSelection({
      rootPath: "/repo",
      relPath: "src/a.ts",
      marker,
      deps,
    })
    expect(sel.snapshot).toBe("src/a.ts:2:5 — error: Cannot find module './x' (typescript)")
  })
})

describe("buildProblemsContextSelection", () => {
  const marker = (over: Partial<ProblemMarkerLike> = {}): ProblemMarkerLike => ({
    message: "boom",
    kind: "error",
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 5,
    ...over,
  })

  it("lists every diagnostic as line:col kind: message", () => {
    const sel = buildProblemsContextSelection({
      relPath: "src/a.ts",
      markers: [
        marker({ startLineNumber: 3, startColumn: 7, message: "no import" }),
        marker({ kind: "warning", startLineNumber: 9, message: "unused", source: "ts" }),
      ],
    })
    expect(sel.title).toBe("a.ts (2)")
    expect(sel.snapshot).toBe(
      "src/a.ts — 2 problems\n3:7 error: no import\n9:1 warning: unused (ts)"
    )
    expect(sel.relPath).toBe("src/a.ts")
  })

  it("caps the list and reports how many were elided", () => {
    const markers = Array.from({ length: PROBLEM_LIST_MAX_MARKERS + 3 }, (_, i) =>
      marker({ startLineNumber: i + 1, message: `m${i}` })
    )
    const sel = buildProblemsContextSelection({
      relPath: "src/a.ts",
      markers,
    })
    expect(sel.title).toBe(`a.ts (${PROBLEM_LIST_MAX_MARKERS + 3})`)
    expect(sel.snapshot).toContain(`${PROBLEM_LIST_MAX_MARKERS + 3} problems`)
    expect(sel.snapshot).toContain("… and 3 more")
    // The cap is real — marker #21's message never makes the snapshot.
    expect(sel.snapshot).not.toContain(`m${PROBLEM_LIST_MAX_MARKERS}`)
  })
})
