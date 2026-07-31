import { fromRawWorkspaceEntry, fromRawWorkspaceStat, fromRawWorkspaceContentMatch } from "./types"

describe("fromRawWorkspaceEntry", () => {
  it("converts snake_case Rust shape to camelCase frontend shape", () => {
    const raw = {
      rel_path: "src/foo.ts",
      absolute_path: "/abs/src/foo.ts",
      is_dir: false,
      size: 1234,
      mtime_ms: 1_700_000_000_000,
    }
    expect(fromRawWorkspaceEntry(raw)).toEqual({
      relPath: "src/foo.ts",
      absolutePath: "/abs/src/foo.ts",
      isDir: false,
      size: 1234,
      mtimeMs: 1_700_000_000_000,
    })
  })

  it("preserves the isDir flag for directory entries", () => {
    const raw = {
      rel_path: "docs",
      absolute_path: "/abs/docs",
      is_dir: true,
      size: 0,
    }
    const out = fromRawWorkspaceEntry(raw)
    expect(out.isDir).toBe(true)
    expect(out.size).toBe(0)
  })

  it("defaults a missing mtime_ms to null", () => {
    const out = fromRawWorkspaceEntry({
      rel_path: "a.txt",
      absolute_path: "/abs/a.txt",
      is_dir: false,
      size: 1,
    })
    expect(out.mtimeMs).toBeNull()
  })
})

describe("fromRawWorkspaceStat", () => {
  it("converts an existing-file stat to camelCase", () => {
    expect(
      fromRawWorkspaceStat({
        exists: true,
        is_dir: false,
        size: 42,
        mtime_ms: 1_700_000_000_000,
      })
    ).toEqual({ exists: true, isDir: false, size: 42, mtimeMs: 1_700_000_000_000 })
  })

  it("maps a missing path (exists=false) with a null mtime", () => {
    expect(fromRawWorkspaceStat({ exists: false, is_dir: false, size: 0 })).toEqual({
      exists: false,
      isDir: false,
      size: 0,
      mtimeMs: null,
    })
  })
})

describe("fromRawWorkspaceContentMatch", () => {
  it("maps a raw content match to camelCase", () => {
    expect(
      fromRawWorkspaceContentMatch({
        rel_path: "src/a.ts",
        absolute_path: "/repo/src/a.ts",
        line: 12,
        column: 5,
        preview: "const needle = 1",
      })
    ).toEqual({
      relPath: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
      line: 12,
      column: 5,
      preview: "const needle = 1",
    })
  })
})
