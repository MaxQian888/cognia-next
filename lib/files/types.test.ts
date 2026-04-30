import { fromRawWorkspaceEntry } from "./types"

describe("fromRawWorkspaceEntry", () => {
  it("converts snake_case Rust shape to camelCase frontend shape", () => {
    const raw = {
      rel_path: "src/foo.ts",
      absolute_path: "/abs/src/foo.ts",
      is_dir: false,
      size: 1234,
    }
    expect(fromRawWorkspaceEntry(raw)).toEqual({
      relPath: "src/foo.ts",
      absolutePath: "/abs/src/foo.ts",
      isDir: false,
      size: 1234,
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
})
