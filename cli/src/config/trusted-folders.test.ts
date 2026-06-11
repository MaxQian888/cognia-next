import path from "node:path"

import {
  isTrusted,
  readTrustedFolders,
  trustFolder,
  trustedFoldersPath,
  type TrustedFoldersFs,
} from "./trusted-folders"

/** In-memory fs double so the tests never touch the real `~/.cognia`. */
function makeMemFs(
  seed: Record<string, string> = {}
): TrustedFoldersFs & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    exists: (p) => store.has(p),
    readText: (p) => {
      const v = store.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    writeText: (p, data) => {
      store.set(p, data)
    },
  }
}

const HOME = "/home/.cognia"
const file = trustedFoldersPath(HOME)

describe("trusted-folders store", () => {
  it("derives the store path under home", () => {
    expect(trustedFoldersPath(HOME)).toBe(path.join(HOME, "trusted-folders.json"))
  })

  it("returns an empty set when the file is missing", () => {
    const fs = makeMemFs()
    expect(readTrustedFolders(HOME, fs).size).toBe(0)
    expect(isTrusted(HOME, "/some/dir", fs)).toBe(false)
  })

  it("returns an empty set when the file is corrupt", () => {
    const fs = makeMemFs({ [file]: "not json {" })
    expect(readTrustedFolders(HOME, fs).size).toBe(0)
  })

  it("ignores non-string and non-array entries", () => {
    const fs = makeMemFs({ [file]: JSON.stringify({ folders: ["/a", 5, null] }) })
    expect([...readTrustedFolders(HOME, fs)]).toEqual(["/a"])
    const bad = makeMemFs({ [file]: JSON.stringify({ folders: "nope" }) })
    expect(readTrustedFolders(HOME, bad).size).toBe(0)
  })

  it("trusts a folder and persists the canonical absolute path", () => {
    const fs = makeMemFs()
    trustFolder(HOME, "/repo/project", fs)
    expect(isTrusted(HOME, "/repo/project", fs)).toBe(true)
    const saved = JSON.parse(fs.store.get(file)!) as { folders: string[] }
    expect(saved.folders).toEqual([path.resolve("/repo/project")])
  })

  it("canonicalizes . / .. / trailing separators to one key", () => {
    const fs = makeMemFs()
    trustFolder(HOME, "/repo/project/", fs)
    expect(isTrusted(HOME, "/repo/project/sub/..", fs)).toBe(true)
  })

  it("is idempotent — trusting twice keeps a single entry", () => {
    const fs = makeMemFs()
    trustFolder(HOME, "/repo/project", fs)
    trustFolder(HOME, "/repo/project", fs)
    const saved = JSON.parse(fs.store.get(file)!) as { folders: string[] }
    expect(saved.folders).toHaveLength(1)
  })

  it("accumulates multiple distinct folders", () => {
    const fs = makeMemFs()
    trustFolder(HOME, "/a", fs)
    trustFolder(HOME, "/b", fs)
    expect(readTrustedFolders(HOME, fs).size).toBe(2)
  })
})
