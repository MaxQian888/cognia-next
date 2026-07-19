/** Node filesystem adapter for the shared headless backup scheduler. */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { BackupFilesystem } from "@/lib/data/backup-scheduler"

export function createNodeBackupFilesystem(): BackupFilesystem {
  return {
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
