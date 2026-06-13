import os from "node:os"
import path from "node:path"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"
import {
  readTrustedOwners,
  isOwnerTrusted,
  addTrustedOwner,
  removeTrustedOwner,
  type TrustFs,
} from "./plugin-trust"

const HOME = "/home/u"
const FILE = path.join(HOME, ".cognia", "plugin-trust.json")

function fakeFs(initial: Record<string, string> = {}): TrustFs & { files: Map<string, string> } {
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

describe("plugin-trust", () => {
  it("returns [] when the file is absent", () => {
    expect(readTrustedOwners(HOME, fakeFs())).toEqual([])
  })

  it("adds an owner (lowercased, deduped) and persists", () => {
    const fs = fakeFs()
    addTrustedOwner(HOME, "Acme", fs)
    addTrustedOwner(HOME, "acme", fs)
    expect(readTrustedOwners(HOME, fs)).toEqual(["acme"])
    expect(fs.files.has(FILE)).toBe(true)
  })

  it("trims whitespace and ignores empty owners", () => {
    const fs = fakeFs()
    addTrustedOwner(HOME, "  vercel  ", fs)
    addTrustedOwner(HOME, "   ", fs)
    expect(readTrustedOwners(HOME, fs)).toEqual(["vercel"])
  })

  it("isOwnerTrusted is case-insensitive", () => {
    const fs = fakeFs()
    addTrustedOwner(HOME, "Anthropics", fs)
    expect(isOwnerTrusted(HOME, "anthropics", fs)).toBe(true)
    expect(isOwnerTrusted(HOME, "ANTHROPICS", fs)).toBe(true)
    expect(isOwnerTrusted(HOME, "other", fs)).toBe(false)
  })

  it("removes an owner (case-insensitive)", () => {
    const fs = fakeFs()
    addTrustedOwner(HOME, "a", fs)
    addTrustedOwner(HOME, "b", fs)
    removeTrustedOwner(HOME, "A", fs)
    expect(readTrustedOwners(HOME, fs)).toEqual(["b"])
  })

  it("returns [] on malformed JSON", () => {
    expect(readTrustedOwners(HOME, fakeFs({ [FILE]: "{bad" }))).toEqual([])
  })

  it("ignores non-string entries", () => {
    const fs = fakeFs({ [FILE]: JSON.stringify({ owners: ["ok", 1, null, "two"] }) })
    expect(readTrustedOwners(HOME, fs)).toEqual(["ok", "two"])
  })

  it("round-trips through the real default fs", async () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-trust-"))
    try {
      addTrustedOwner(home, "Vercel")
      expect(isOwnerTrusted(home, "vercel")).toBe(true)
      removeTrustedOwner(home, "vercel")
      expect(readTrustedOwners(home)).toEqual([])
    } finally {
      await nodeFsP.rm(home, { recursive: true, force: true })
    }
  })
})
