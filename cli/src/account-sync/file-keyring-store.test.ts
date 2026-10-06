import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createFileKeyringStore, keyFileName } from "./file-keyring-store"

let dir: string

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-keyring-")), "account-sync")
})
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }))

describe("createFileKeyringStore", () => {
  it("saves, loads and deletes values, each in its own private file", async () => {
    const store = createFileKeyringStore(dir)
    expect(await store.load("acct:space:device")).toBeNull()
    await store.save("acct:space:device", '{"k":1}')
    await store.save("acct:space:chain", "chain")
    expect(await store.load("acct:space:device")).toBe('{"k":1}')
    expect(await store.load("acct:space:chain")).toBe("chain")
    expect(store.isPersistent?.()).toBe(true)

    const files = fs.readdirSync(dir)
    expect(files.sort()).toEqual(
      [keyFileName("acct:space:chain"), keyFileName("acct:space:device")].sort()
    )
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(dir, keyFileName("acct:space:device"))).mode & 0o777).toBe(0o600)
    }

    await store.delete("acct:space:device")
    await store.delete("acct:space:missing")
    expect(await store.load("acct:space:device")).toBeNull()
    expect(fs.readdirSync(dir)).toEqual([keyFileName("acct:space:chain")])
  })

  it("lets two stores on one directory see each other's writes (the CLI and the brain)", async () => {
    const cli = createFileKeyringStore(dir)
    const brain = createFileKeyringStore(dir)
    await cli.save("a:b:device", "keys")
    expect(await brain.load("a:b:device")).toBe("keys")
    await brain.save("a:b:pin", "pin")
    expect(await cli.load("a:b:pin")).toBe("pin")
  })

  it("never maps two keys to one file, and leaves no temporary files behind", async () => {
    expect(keyFileName("a:b")).not.toBe(keyFileName("a_b"))
    expect(keyFileName("../x")).not.toContain("/")
    const store = createFileKeyringStore(dir)
    await store.save("a:b", "1")
    await store.save("a:b", "2")
    expect(await store.load("a:b")).toBe("2")
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})
