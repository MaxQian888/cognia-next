import { mkdtemp, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createNodeBackupFilesystem } from "./backup-filesystem"

describe("createNodeBackupFilesystem", () => {
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
