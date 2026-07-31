import { promises as fsp } from "node:fs"
import os from "node:os"
import path from "node:path"

import { nodeSessionFs } from "./node-session-fs"

describe("nodeSessionFs", () => {
  let dir: string
  const fs = nodeSessionFs()

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cognia-fs-"))
    await fsp.writeFile(path.join(dir, "a.txt"), "hello", "utf8")
    await fsp.mkdir(path.join(dir, "sub"))
  })
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it("exists() reflects presence", async () => {
    expect(await fs.exists(path.join(dir, "a.txt"))).toBe(true)
    expect(await fs.exists(path.join(dir, "nope"))).toBe(false)
  })

  it("readDir() lists basenames", async () => {
    const names = await fs.readDir(dir)
    expect(names.sort()).toEqual(["a.txt", "sub"])
  })

  it("stat() reports size + isFile", async () => {
    const f = await fs.stat(path.join(dir, "a.txt"))
    expect(f.isFile).toBe(true)
    expect(f.size).toBe(5)
    const d = await fs.stat(path.join(dir, "sub"))
    expect(d.isFile).toBe(false)
  })

  it("readTextFile() returns contents", async () => {
    expect(await fs.readTextFile(path.join(dir, "a.txt"))).toBe("hello")
  })
})
