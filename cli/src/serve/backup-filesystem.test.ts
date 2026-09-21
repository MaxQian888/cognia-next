import { mkdtemp, readFile, stat, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createNodeBackupFilesystem } from "./backup-filesystem"

describe("createNodeBackupFilesystem", () => {
  it("atomically writes stream chunks and retains the previous backup when generation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-backup-stream-"))
    try {
      const fs = createNodeBackupFilesystem()
      const target = path.join(root, "backup.cbk")
      const encoder = new TextEncoder()
      expect(
        await fs.writeStream!(
          target,
          (async function* () {
            yield encoder.encode("one")
            yield encoder.encode("two")
          })()
        )
      ).toBe(6)
      expect(await readFile(target, "utf8")).toBe("onetwo")
      await expect(
        fs.writeStream!(
          target,
          (async function* () {
            yield encoder.encode("broken")
            throw new Error("source read failed")
          })()
        )
      ).rejects.toThrow("source read failed")
      expect(await readFile(target, "utf8")).toBe("onetwo")
      expect(await fs.readDirNames(root)).toEqual(["backup.cbk"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("writes private files, lists names, and removes retained backups", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-backup-fs-"))
    const target = path.join(root, "nested", "backup.enc.cbk")
    const filesystem = createNodeBackupFilesystem()

    await filesystem.writeTextFile(target, "encrypted")
    expect(await readFile(target, "utf8")).toBe("encrypted")
    expect(await filesystem.readDirNames(path.dirname(target))).toEqual(["backup.enc.cbk"])
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    }

    await filesystem.remove(target)
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
