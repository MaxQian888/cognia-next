import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeIo } from "./node-io"

jest.mock("node:child_process", () => ({ execFileSync: jest.fn() }))

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cognia-convert-io-"))
  mockExecFileSync.mockReset()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("nodeIo file operations", () => {
  it("round-trips a file", () => {
    const path = join(root, "a.txt")
    nodeIo.writeFile(path, "hello")
    expect(nodeIo.readFile(path)).toBe("hello")
    expect(nodeIo.exists(path)).toBe(true)
  })

  it("creates nested directories", () => {
    const nested = join(root, "a", "b", "c")
    nodeIo.mkdirp(nested)
    expect(nodeIo.isDirectory(nested)).toBe(true)
  })

  it("distinguishes files from directories", () => {
    const file = join(root, "f.txt")
    writeFileSync(file, "x")
    expect(nodeIo.isDirectory(file)).toBe(false)
    expect(nodeIo.isDirectory(root)).toBe(true)
    expect(nodeIo.isDirectory(join(root, "missing"))).toBe(false)
  })

  it("copies a file", () => {
    writeFileSync(join(root, "src.txt"), "body")
    nodeIo.copyFile(join(root, "src.txt"), join(root, "dst.txt"))
    expect(readFileSync(join(root, "dst.txt"), "utf8")).toBe("body")
  })

  it("lists direct entries with readDir", () => {
    writeFileSync(join(root, "a.txt"), "")
    mkdirSync(join(root, "sub"))
    expect(nodeIo.readDir(root).sort()).toEqual(["a.txt", "sub"])
  })
})

describe("nodeIo.listFiles", () => {
  it("walks recursively and returns forward-slash relative paths", () => {
    mkdirSync(join(root, "references"))
    writeFileSync(join(root, "SKILL.md"), "")
    writeFileSync(join(root, "references", "api.md"), "")
    expect(nodeIo.listFiles(root).sort()).toEqual(["SKILL.md", "references/api.md"])
  })

  it("skips VCS and dependency directories", () => {
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "node_modules"))
    writeFileSync(join(root, ".git", "config"), "")
    writeFileSync(join(root, "node_modules", "x.js"), "")
    writeFileSync(join(root, "SKILL.md"), "")
    expect(nodeIo.listFiles(root)).toEqual(["SKILL.md"])
  })
})

describe("nodeIo path helpers", () => {
  it("resolves relative paths against the process cwd", () => {
    expect(nodeIo.resolve("x")).toBe(join(process.cwd(), "x"))
  })

  it("returns the last segment from basename", () => {
    expect(nodeIo.basename("/a/b/c")).toBe("c")
  })
})

describe("nodeIo.gitAuthor", () => {
  it("returns the configured name", () => {
    mockExecFileSync.mockReturnValue("Ada Lovelace\n" as never)
    expect(nodeIo.gitAuthor()).toBe("Ada Lovelace")
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "user.name"],
      expect.objectContaining({ encoding: "utf8" })
    )
  })

  it("returns undefined when git has no configured name", () => {
    mockExecFileSync.mockReturnValue("  \n" as never)
    expect(nodeIo.gitAuthor()).toBeUndefined()
  })

  it("returns undefined instead of throwing when git is unavailable", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(nodeIo.gitAuthor()).toBeUndefined()
  })
})
