import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { appendHistory, HISTORY_LIMIT, historyPath, loadHistory } from "./history-store"

function memStore(initial: Record<string, string> = {}) {
  const files = { ...initial }
  return {
    files,
    readFile: (p: string): string | null => (p in files ? files[p] : null),
    writeFile: (p: string, data: string): void => {
      files[p] = data
    },
  }
}

const HOME = "/home/.cognia"

describe("loadHistory", () => {
  it("returns [] when the file is absent", () => {
    const s = memStore()
    expect(loadHistory(HOME, s)).toEqual([])
  })

  it("parses one entry per line, oldest first, dropping blanks", () => {
    const s = memStore({ [historyPath(HOME)]: "first\nsecond\n\nthird\n" })
    expect(loadHistory(HOME, s)).toEqual(["first", "second", "third"])
  })

  it("round-trips a multi-line entry as a single entry", () => {
    const s = memStore()
    appendHistory(HOME, "line1\nline2", s)
    expect(loadHistory(HOME, s)).toEqual(["line1\nline2"])
  })

  it("caps the loaded history to the limit", () => {
    const many = Array.from({ length: HISTORY_LIMIT + 50 }, (_, i) => `e${i}`).join("\n")
    const s = memStore({ [historyPath(HOME)]: many })
    const loaded = loadHistory(HOME, s)
    expect(loaded).toHaveLength(HISTORY_LIMIT)
    expect(loaded[loaded.length - 1]).toBe(`e${HISTORY_LIMIT + 49}`)
  })

  it("uses a 100-entry cap matching Claude Code", () => {
    expect(HISTORY_LIMIT).toBe(100)
  })
})

describe("appendHistory", () => {
  it("appends and persists an entry", () => {
    const s = memStore()
    appendHistory(HOME, "echo hi", s)
    expect(loadHistory(HOME, s)).toEqual(["echo hi"])
  })

  it("ignores a blank entry", () => {
    const s = memStore({ [historyPath(HOME)]: "keep\n" })
    expect(appendHistory(HOME, "   ", s)).toEqual(["keep"])
  })

  it("skips a consecutive duplicate", () => {
    const s = memStore()
    appendHistory(HOME, "dup", s)
    const result = appendHistory(HOME, "dup", s)
    expect(result).toEqual(["dup"])
  })

  it("keeps a non-consecutive repeat", () => {
    const s = memStore()
    appendHistory(HOME, "a", s)
    appendHistory(HOME, "b", s)
    expect(appendHistory(HOME, "a", s)).toEqual(["a", "b", "a"])
  })

  it("caps persisted history to the limit", () => {
    const s = memStore()
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) appendHistory(HOME, `e${i}`, s)
    expect(loadHistory(HOME, s)).toHaveLength(HISTORY_LIMIT)
  })

  it("swallows write failures", () => {
    const s = {
      readFile: () => null,
      writeFile: () => {
        throw new Error("read-only")
      },
    }
    expect(() => appendHistory(HOME, "x", s)).not.toThrow()
  })
})

describe("history-store default filesystem", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-hist-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips through the real fs reader/writer", () => {
    expect(loadHistory(dir)).toEqual([]) // missing file → []
    appendHistory(dir, "alpha")
    appendHistory(dir, "beta")
    expect(loadHistory(dir)).toEqual(["alpha", "beta"])
    expect(fs.existsSync(historyPath(dir))).toBe(true)
  })

  it("returns [] when the real read hits a missing file", () => {
    expect(loadHistory(path.join(dir, "nope"))).toEqual([])
  })
})
