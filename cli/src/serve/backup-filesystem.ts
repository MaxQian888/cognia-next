/** Node filesystem adapter for the shared headless backup scheduler. */

import { mkdir, readdir, rm, writeFile, open, rename } from "node:fs/promises"
import path from "node:path"

import type { BackupFilesystem } from "@/lib/data/backup-scheduler"

export function createNodeBackupFilesystem(): BackupFilesystem {
  return {
    async writeStream(target, source) {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      const file = await open(temporary, "wx", 0o600)
      let size = 0
      try {
        for await (const chunk of source) {
          let offset = 0
          while (offset < chunk.byteLength) {
            const result = await file.write(chunk, offset, chunk.byteLength - offset)
            if (result.bytesWritten === 0) throw new Error("backup_write_failed")
            offset += result.bytesWritten
          }
          size += chunk.byteLength
        }
        await file.sync()
        await file.close()
        await rename(temporary, target)
        return size
      } catch (error) {
        await file.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    },
    async writeTextFile(target, contents) {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, contents, { encoding: "utf8", mode: 0o600 })
    },
    async readDirNames(directory) {
      return readdir(directory)
    },
    async remove(target) {
      await rm(target, { force: true })
    },
  }
}
