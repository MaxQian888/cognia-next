/**
 * A `KeyringStore` in files, for account sync on a headless host (ADR-0215
 * phase 3a). The `cognia-agent account-sync` commands enroll the host and the
 * brain (`cognia-agent serve`) syncs with the same keys, as two processes, so
 * they share a directory rather than the brain's server-side secret store
 * (reachable only with the brain's service token). Like the CLI's Logto
 * session (`~/.cognia/logto.json`), the files are the user's alone: the
 * directory is 0700 and every file 0600.
 *
 * One file per key, each written to a temporary file and renamed into place,
 * so a reader never sees half a value and two processes writing different
 * keys never lose each other's writes.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { KeyringStore } from "@/lib/credentials/keyring-store"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export interface KeyringFs {
  readFile(file: string): string | null
  writeFileAtomic(file: string, content: string): void
  removeFile(file: string): void
  mkdirp(dir: string): void
}

export const realKeyringFs: KeyringFs = {
  readFile(file) {
    try {
      return fs.readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  },
  writeFileAtomic(file, content) {
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    fs.writeFileSync(temp, content, { mode: FILE_MODE })
    try {
      fs.chmodSync(temp, FILE_MODE)
    } catch {
      // Best effort: Windows ignores chmod.
    }
    fs.renameSync(temp, file)
  },
  removeFile(file) {
    try {
      fs.unlinkSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  },
  mkdirp(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    try {
      fs.chmodSync(dir, DIR_MODE)
    } catch {
      // Best effort.
    }
  },
}

/** A file name for a key: readable where safe, and never two keys on one file. */
export function keyFileName(keyId: string): string {
  const safe = keyId.replace(
    /[^A-Za-z0-9._-]/g,
    (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`
  )
  return `${safe}.secret`
}

export function createFileKeyringStore(dir: string, io: KeyringFs = realKeyringFs): KeyringStore {
  const fileOf = (keyId: string) => path.join(dir, keyFileName(keyId))
  return {
    async save(keyId, value) {
      io.mkdirp(dir)
      io.writeFileAtomic(fileOf(keyId), value)
    },
    async load(keyId) {
      return io.readFile(fileOf(keyId))
    },
    async delete(keyId) {
      io.removeFile(fileOf(keyId))
    },
    isPersistent: () => true,
  }
}
