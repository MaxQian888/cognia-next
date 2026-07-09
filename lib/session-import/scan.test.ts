import { scanFileSummaries } from "./scan"
import type { SessionFs, SessionScanInput, SessionSummary } from "./types"

function summaryOf(id: string, updatedAt: number): SessionSummary {
  return {
    ref: { sourceId: "test", originalSessionId: id, locator: `/root/${id}.jsonl` },
    title: id,
    sourceId: "test",
    messageCount: 1,
    updatedAt,
  }
}

/** Fake fs over an in-memory tree of dirs → children and files → content. */
function fakeFs(tree: {
  dirs: Record<string, string[]>
  files: Record<string, string>
  unreadable?: Set<string>
}): SessionFs {
  return {
    async exists() {
      return true
    },
    async readDir(path) {
      return tree.dirs[path] ?? []
    },
    async stat(path) {
      return { size: 0, isFile: path in tree.files }
    },
    async readTextFile(path) {
      if (tree.unreadable?.has(path)) throw new Error("EACCES")
      return tree.files[path] ?? ""
    },
  }
}

const accept = (name: string) => name.toLowerCase().endsWith(".jsonl")

describe("scanFileSummaries — picked files", () => {
  const input: SessionScanInput = {
    fs: fakeFs({ dirs: {}, files: {} }),
    home: "",
    pickedFiles: [
      { name: "a.jsonl", path: "/p/a.jsonl", content: "A" },
      { name: "notes.txt", path: "/p/notes.txt", content: "nope" },
      { name: "b.jsonl", path: "/p/b.jsonl", content: "B" },
    ],
  }

  it("summarizes only accepted files and skips null summaries", async () => {
    const summarize = (content: string, locator: string) =>
      content === "B" ? null : summaryOf(content, content === "A" ? 100 : 0)
    const out = await scanFileSummaries(input, [], accept, summarize)
    expect(out.map((s) => s.title)).toEqual(["A"]) // .txt filtered, B → null
  })
})

describe("scanFileSummaries — desktop walk", () => {
  const fs = fakeFs({
    dirs: { "/root": ["a.jsonl", "b.jsonl", "skip.txt", "bad.jsonl"] },
    files: {
      "/root/a.jsonl": "A",
      "/root/b.jsonl": "B",
      "/root/skip.txt": "x",
      "/root/bad.jsonl": "BAD",
    },
    unreadable: new Set(["/root/bad.jsonl"]),
  })
  const input: SessionScanInput = { fs, home: "/home" }

  it("reads each accepted file once, skips unreadable, sorts newest-first", async () => {
    const reads: string[] = []
    const wrappedFs: SessionFs = {
      ...fs,
      async readTextFile(path) {
        reads.push(path)
        return fs.readTextFile(path)
      },
    }
    const summarize = (content: string) => summaryOf(content, content === "A" ? 10 : 99)
    const out = await scanFileSummaries({ ...input, fs: wrappedFs }, ["/root"], accept, summarize)

    // .txt never read; bad.jsonl attempted but threw → dropped.
    expect(reads).toEqual(["/root/a.jsonl", "/root/b.jsonl", "/root/bad.jsonl"])
    expect(out.map((s) => s.title)).toEqual(["B", "A"]) // newest (99) first
  })

  it("returns [] when the root has no matching files", async () => {
    const empty = fakeFs({ dirs: { "/root": ["only.txt"] }, files: { "/root/only.txt": "x" } })
    const out = await scanFileSummaries({ fs: empty, home: "/home" }, ["/root"], accept, () =>
      summaryOf("x", 1)
    )
    expect(out).toEqual([])
  })
})
