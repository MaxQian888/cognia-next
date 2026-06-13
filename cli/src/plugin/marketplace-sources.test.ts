import path from "node:path"
import { readSources, addSource, removeSource, type SourcesFs } from "./marketplace-sources"

const HOME = "/home/u"
const FILE = path.join(HOME, ".cognia", "plugin-marketplace-sources.json")

function fakeFs(initial: Record<string, string> = {}): SourcesFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFileSync: (p: string) => {
      const v = files.get(p)
      if (v === undefined) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException
        e.code = "ENOENT"
        throw e
      }
      return v
    },
    writeFileSync: (p: string, c: string) => void files.set(p, c),
    mkdirSync: () => {},
  }
}

describe("marketplace-sources", () => {
  it("returns [] when the file is absent", () => {
    expect(readSources(HOME, fakeFs())).toEqual([])
  })

  it("adds a source (dedup by repoRef) and persists it", () => {
    const fs = fakeFs()
    addSource(HOME, "owner/repo", fs)
    addSource(HOME, "owner/repo", fs)
    expect(readSources(HOME, fs)).toEqual(["owner/repo"])
    expect(fs.files.has(FILE)).toBe(true)
  })

  it("trims whitespace and ignores empty refs", () => {
    const fs = fakeFs()
    addSource(HOME, "  owner/repo  ", fs)
    addSource(HOME, "   ", fs)
    expect(readSources(HOME, fs)).toEqual(["owner/repo"])
  })

  it("removes a source", () => {
    const fs = fakeFs()
    addSource(HOME, "a/b", fs)
    addSource(HOME, "c/d", fs)
    removeSource(HOME, "a/b", fs)
    expect(readSources(HOME, fs)).toEqual(["c/d"])
  })

  it("returns [] on malformed JSON", () => {
    const fs = fakeFs({ [FILE]: "{bad" })
    expect(readSources(HOME, fs)).toEqual([])
  })

  it("ignores non-string entries in the sources array", () => {
    const fs = fakeFs({ [FILE]: JSON.stringify({ sources: ["ok", 42, null, "two"] }) })
    expect(readSources(HOME, fs)).toEqual(["ok", "two"])
  })
})
