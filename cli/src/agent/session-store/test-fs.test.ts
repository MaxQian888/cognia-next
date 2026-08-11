import path from "node:path"

import { createMemoryFs } from "./test-fs"

const DIR = path.join(path.sep, "a", "b")
const FILE = path.join(DIR, "f.txt")

describe("createMemoryFs", () => {
  it("seeds files and their implied parent directories", () => {
    const fsx = createMemoryFs({ [FILE]: "hi" })
    expect(fsx.readFile(FILE)).toBe("hi")
    expect(fsx.exists(FILE)).toBe(true)
    expect(fsx.isDirectory(DIR)).toBe(true)
    expect(fsx.isDirectory(FILE)).toBe(false)
  })

  it("reads a missing file as null", () => {
    expect(createMemoryFs().readFile(FILE)).toBeNull()
  })

  it("models exclusive create: the second attempt fails without clobbering", () => {
    const fsx = createMemoryFs()
    expect(fsx.writeFileExclusive(FILE, "first")).toBe(true)
    expect(fsx.writeFileExclusive(FILE, "second")).toBe(false)
    expect(fsx.readFile(FILE)).toBe("first")
  })

  it("models atomic write as all-or-nothing", () => {
    const fsx = createMemoryFs({ [FILE]: "before" })
    fsx.failNextWrite(FILE)
    expect(() => fsx.writeFileAtomic(FILE, "after")).toThrow(/simulated write failure/)
    expect(fsx.readFile(FILE)).toBe("before")
    // The failure is one-shot.
    fsx.writeFileAtomic(FILE, "after")
    expect(fsx.readFile(FILE)).toBe("after")
  })

  it("appends rather than replacing", () => {
    const fsx = createMemoryFs()
    fsx.appendFile(FILE, "a\n")
    fsx.appendFile(FILE, "b\n")
    expect(fsx.readFile(FILE)).toBe("a\nb\n")
  })

  it("lists immediate children only, from both files and directories", () => {
    const fsx = createMemoryFs({
      [path.join(DIR, "one.txt")]: "1",
      [path.join(DIR, "sub", "two.txt")]: "2",
    })
    expect(fsx.readdir(DIR)).toEqual(["one.txt", "sub"])
    expect(fsx.readdir(path.join(path.sep, "nowhere"))).toEqual([])
  })

  it("removes a file and tolerates removing a missing one", () => {
    const fsx = createMemoryFs({ [FILE]: "hi" })
    fsx.removeFile(FILE)
    expect(fsx.exists(FILE)).toBe(false)
    expect(() => fsx.removeFile(FILE)).not.toThrow()
  })

  it("removes a directory and every descendant without touching siblings", () => {
    const sibling = path.join(path.dirname(DIR), "sibling.txt")
    const fsx = createMemoryFs({
      [FILE]: "one",
      [path.join(DIR, "nested", "two.txt")]: "two",
      [sibling]: "keep",
    })

    fsx.removeDir(DIR)

    expect(fsx.exists(DIR)).toBe(false)
    expect(fsx.exists(FILE)).toBe(false)
    expect(fsx.exists(path.join(DIR, "nested", "two.txt"))).toBe(false)
    expect(fsx.readFile(sibling)).toBe("keep")
    expect(() => fsx.removeDir(DIR)).not.toThrow()
  })

  it("creates directories explicitly and reports mtime only for files", () => {
    const fsx = createMemoryFs()
    fsx.mkdirp(DIR)
    expect(fsx.isDirectory(DIR)).toBe(true)
    expect(fsx.mtimeMs(FILE)).toBeNull()
    fsx.appendFile(FILE, "x")
    expect(fsx.mtimeMs(FILE)).toBe(0)
  })
})
