import {
  countDiffStats,
  extractEditInput,
  fallbackStats,
  isFileEditTool,
  produceUnifiedHunks,
  MAX_DIFF_BYTES,
} from "./diff-producer"

describe("produceUnifiedHunks", () => {
  it("returns no hunks for identical strings", () => {
    expect(produceUnifiedHunks("abc", "abc")).toEqual([])
  })

  it("returns no hunks for two empty strings", () => {
    expect(produceUnifiedHunks("", "")).toEqual([])
  })

  it("pure insertion produces an all-add hunk", () => {
    const hunks = produceUnifiedHunks("", "a\nb\nc")
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.every((l) => l.kind === "add")).toBe(true)
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["a", "b", "c"])
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[0].oldStart).toBe(0)
  })

  it("pure deletion produces an all-del hunk", () => {
    const hunks = produceUnifiedHunks("a\nb\nc", "")
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.every((l) => l.kind === "del")).toBe(true)
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].newStart).toBe(0)
  })

  it("mixed change carries context lines and correct line numbers", () => {
    const old = "1\n2\n3\n4\n5\n6\n7\n8\n9"
    const next = "1\n2\nCHANGED\n4\n5\n6\n7\n8\n9"
    const hunks = produceUnifiedHunks(old, next, 1)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]
    // context line "2" before, del "3", add "CHANGED", context "4"
    expect(h.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "context:2",
      "del:3",
      "add:CHANGED",
      "context:4",
    ])
    expect(h.lines[0].oldNo).toBe(2)
    expect(h.lines[0].newNo).toBe(2)
    expect(h.lines[1].oldNo).toBe(3)
    expect(h.lines[2].newNo).toBe(3)
  })

  it("merges two nearby changes into one hunk when within 2*context", () => {
    const old = "1\n2\n3\n4\n5"
    const next = "X\n2\n3\n4\nY"
    const hunks = produceUnifiedHunks(old, next, 3)
    expect(hunks).toHaveLength(1)
    // both ends changed, gap is 3 context lines (2,3,4) which is <= 2*3 → merge.
    // Full hunk: del(1) add(X) ctx(2) ctx(3) ctx(4) del(5) add(Y) = 7 lines.
    const kinds = hunks[0].lines.map((l) => `${l.kind}:${l.text}`)
    expect(kinds).toEqual([
      "del:1",
      "add:X",
      "context:2",
      "context:3",
      "context:4",
      "del:5",
      "add:Y",
    ])
  })

  it("splits two far-apart changes into separate hunks", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n")
    const next = old.replace("line0", "ZERO").replace("line19", "NINETEEN")
    const hunks = produceUnifiedHunks(old, next, 1)
    expect(hunks.length).toBe(2)
  })

  it("returns [] when input exceeds the size cap", () => {
    const big = "x".repeat(MAX_DIFF_BYTES + 1)
    expect(produceUnifiedHunks(big, "y")).toEqual([])
  })
})

describe("countDiffStats", () => {
  it("counts added and removed across hunks", () => {
    const hunks = produceUnifiedHunks("a\nb\nc", "a\nB\nc")
    const stats = countDiffStats(hunks)
    expect(stats).toEqual({ added: 1, removed: 1 })
  })

  it("returns zeros for empty hunks", () => {
    expect(countDiffStats([])).toEqual({ added: 0, removed: 0 })
  })
})

describe("fallbackStats", () => {
  it("treats the change as a full replace", () => {
    expect(fallbackStats("a\nb\nc", "x\ny")).toEqual({ added: 2, removed: 3 })
  })

  it("handles empty strings", () => {
    expect(fallbackStats("", "")).toEqual({ added: 0, removed: 0 })
  })
})

describe("extractEditInput", () => {
  it("returns kind null for a non-edit tool", () => {
    expect(extractEditInput("bash", { command: "ls" }).kind).toBeNull()
  })

  it("returns kind null when no file path is present", () => {
    expect(extractEditInput("edit", { old_string: "a", new_string: "b" }).kind).toBeNull()
  })

  it("extracts an edit tool call", () => {
    const r = extractEditInput("edit", {
      file_path: "lib/x.ts",
      old_string: "a\nb",
      new_string: "a\nB",
    })
    expect(r.kind).toBe("edit")
    expect(r.filePath).toBe("lib/x.ts")
    expect(r.stats).toEqual({ added: 1, removed: 1 })
    expect(r.tooLarge).toBe(false)
  })

  it("accepts filePath/path aliases and oldString/newString aliases", () => {
    const r = extractEditInput("str_replace", {
      path: "y.ts",
      oldString: "a",
      newString: "b",
    })
    expect(r.kind).toBe("edit")
    expect(r.filePath).toBe("y.ts")
    expect(r.stats).toEqual({ added: 1, removed: 1 })
  })

  it("extracts a write tool call as all-add", () => {
    const r = extractEditInput("write", { file_path: "new.ts", content: "a\nb\nc" })
    expect(r.kind).toBe("write")
    expect(r.stats).toEqual({ added: 3, removed: 0 })
  })

  it("extracts a multi_edit tool call with per-edit deltas summed", () => {
    const r = extractEditInput("multi_edit", {
      file_path: "z.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "BB" },
      ],
    })
    expect(r.kind).toBe("multiedit")
    expect(r.stats).toEqual({ added: 2, removed: 2 })
  })

  it("skips malformed edit entries in a multi_edit", () => {
    const r = extractEditInput("multi_edit", {
      file_path: "z.ts",
      edits: [{ old_string: "a", new_string: "A" }, "junk", null],
    })
    expect(r.kind).toBe("multiedit")
    expect(r.stats).toEqual({ added: 1, removed: 1 })
  })

  it("flags tooLarge and falls back to rough stats on a huge edit", () => {
    const big = "x".repeat(MAX_DIFF_BYTES + 1)
    const r = extractEditInput("edit", { file_path: "big.ts", old_string: big, new_string: "y" })
    expect(r.kind).toBe("edit")
    expect(r.tooLarge).toBe(true)
    expect(r.hunks).toEqual([])
    expect(r.stats.removed).toBeGreaterThan(0)
  })

  it("flags tooLarge on a huge write", () => {
    const big = "x".repeat(MAX_DIFF_BYTES + 1)
    const r = extractEditInput("write", { file_path: "big.ts", content: big })
    expect(r.kind).toBe("write")
    expect(r.tooLarge).toBe(true)
    expect(r.stats.added).toBeGreaterThan(0)
  })
})

describe("isFileEditTool", () => {
  it("recognizes the known edit tool names case-insensitively", () => {
    expect(isFileEditTool("edit")).toBe(true)
    expect(isFileEditTool("Write")).toBe(true)
    expect(isFileEditTool("MULTI_EDIT")).toBe(true)
    expect(isFileEditTool("str_replace")).toBe(true)
    expect(isFileEditTool("create")).toBe(true)
  })

  it("rejects non-edit tools", () => {
    expect(isFileEditTool("bash")).toBe(false)
    expect(isFileEditTool("read")).toBe(false)
  })
})
