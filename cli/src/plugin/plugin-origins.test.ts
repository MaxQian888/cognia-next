import path from "node:path"
import {
  readOrigins,
  getOrigin,
  recordOrigin,
  removeOrigin,
  type OriginsFs,
} from "./plugin-origins"

const HOME = "/home/u"
const FILE = path.join(HOME, ".cognia", "plugin-origins.json")

function fakeFs(initial: Record<string, string> = {}): OriginsFs & { files: Map<string, string> } {
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

describe("plugin-origins", () => {
  it("returns {} when the file is absent", () => {
    expect(readOrigins(HOME, fakeFs())).toEqual({})
  })

  it("records an origin and reads it back", () => {
    const fs = fakeFs()
    recordOrigin(
      HOME,
      "acme.hello",
      {
        repoRef: "acme/hello@v1",
        version: "1.0.0",
        fingerprint: "abc",
        installedAt: 42,
      },
      fs
    )
    expect(readOrigins(HOME, fs)).toEqual({
      "acme.hello": {
        repoRef: "acme/hello@v1",
        version: "1.0.0",
        fingerprint: "abc",
        installedAt: 42,
      },
    })
    expect(fs.files.has(FILE)).toBe(true)
  })

  it("getOrigin returns a single entry or undefined", () => {
    const fs = fakeFs()
    recordOrigin(
      HOME,
      "a.b",
      { repoRef: "a/b", version: "1", fingerprint: "f", installedAt: 1 },
      fs
    )
    expect(getOrigin(HOME, "a.b", fs)?.repoRef).toBe("a/b")
    expect(getOrigin(HOME, "missing", fs)).toBeUndefined()
  })

  it("overwrites an existing origin on re-record", () => {
    const fs = fakeFs()
    recordOrigin(
      HOME,
      "a.b",
      { repoRef: "a/b", version: "1.0.0", fingerprint: "old", installedAt: 1 },
      fs
    )
    recordOrigin(
      HOME,
      "a.b",
      { repoRef: "a/b", version: "2.0.0", fingerprint: "new", installedAt: 2 },
      fs
    )
    expect(getOrigin(HOME, "a.b", fs)).toEqual({
      repoRef: "a/b",
      version: "2.0.0",
      fingerprint: "new",
      installedAt: 2,
    })
  })

  it("defaults installedAt when omitted", () => {
    const fs = fakeFs()
    recordOrigin(HOME, "a.b", { repoRef: "a/b", version: "1", fingerprint: "f" }, fs)
    expect(getOrigin(HOME, "a.b", fs)?.installedAt).toBeGreaterThan(0)
  })

  it("removes an origin (and is a no-op for unknown ids)", () => {
    const fs = fakeFs()
    recordOrigin(
      HOME,
      "a.b",
      { repoRef: "a/b", version: "1", fingerprint: "f", installedAt: 1 },
      fs
    )
    removeOrigin(HOME, "nope", fs)
    expect(getOrigin(HOME, "a.b", fs)).toBeDefined()
    removeOrigin(HOME, "a.b", fs)
    expect(readOrigins(HOME, fs)).toEqual({})
  })

  it("returns {} on malformed JSON", () => {
    expect(readOrigins(HOME, fakeFs({ [FILE]: "{bad" }))).toEqual({})
  })

  it("skips entries missing a repoRef and fills defaults for partial entries", () => {
    const fs = fakeFs({
      [FILE]: JSON.stringify({
        origins: {
          good: { repoRef: "x/y" },
          bad: { version: "1.0.0" },
          notObject: 5,
        },
      }),
    })
    expect(readOrigins(HOME, fs)).toEqual({
      good: { repoRef: "x/y", version: "0.0.0", fingerprint: "", installedAt: 0 },
    })
  })

  it("returns {} when origins is not an object", () => {
    expect(readOrigins(HOME, fakeFs({ [FILE]: JSON.stringify({ origins: [] }) }))).toEqual({})
  })
})
