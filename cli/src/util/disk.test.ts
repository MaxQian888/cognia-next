/**
 * @jest-environment node
 */
import { directoryBytes, formatBytes, freeBytesAt, type ReadOnlyDirFs } from "./disk"

function tree(files: Record<string, number>): ReadOnlyDirFs {
  const dirs = new Set<string>()
  for (const file of Object.keys(files)) {
    const parts = file.split("/")
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
  }
  return {
    async readdir(path) {
      if (!dirs.has(path)) throw new Error(`ENOENT ${path}`)
      const names = new Set<string>()
      for (const candidate of [...dirs, ...Object.keys(files)]) {
        if (candidate.startsWith(`${path}/`))
          names.add(candidate.slice(path.length + 1).split("/")[0]!)
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => dirs.has(`${path}/${name}`),
        isFile: () => `${path}/${name}` in files,
      }))
    },
    async stat(path) {
      if (!(path in files)) throw new Error(`ENOENT ${path}`)
      return { size: files[path]! }
    },
  }
}

describe("freeBytesAt", () => {
  it("multiplies available blocks by block size, accepting bigint fields", async () => {
    expect(await freeBytesAt("/x", async () => ({ bavail: 10n, bsize: 4096n }))).toBe(40_960)
    expect(await freeBytesAt("/x", async () => ({ bavail: 3, bsize: 512 }))).toBe(1536)
  })

  it("answers undefined when statfs fails", async () => {
    expect(
      await freeBytesAt("/x", async () => {
        throw new Error("EACCES")
      })
    ).toBeUndefined()
  })
})

describe("directoryBytes", () => {
  it("sums files across nested directories", async () => {
    const fsx = tree({ "/r/a.log": 10, "/r/sub/b.log": 20, "/r/sub/deep/c.log": 30 })
    expect(await directoryBytes("/r", fsx)).toBe(60)
    expect(await directoryBytes("/r/sub", fsx)).toBe(50)
  })

  it("answers undefined for a directory that cannot be read", async () => {
    expect(await directoryBytes("/nowhere", tree({}))).toBeUndefined()
  })
})

describe("formatBytes", () => {
  it("scales to the largest unit under 1024", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB")
    expect(formatBytes(undefined)).toBe("?")
  })
})
