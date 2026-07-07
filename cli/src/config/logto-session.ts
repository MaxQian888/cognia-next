/**
 * File-backed persistence for the CLI's active Logto session
 * (ADR-0059 cloud/headless — Logto). The standalone `cognia-agent` process has
 * no OS keyring, so — like `~/.cognia/credentials.json` — the session lives in
 * `~/.cognia/logto.json` with 0600 perms. All filesystem effects go through an
 * injectable {@link LogtoSessionFs} so the store unit-tests without real disk.
 */

import fs from "node:fs"
import path from "node:path"

import type { LogtoSession } from "@/lib/logto/client"

const MODE_0600 = 0o600

export interface LogtoSessionFs {
  read(absPath: string): string | null
  write(absPath: string, content: string, mode: number): void
  remove(absPath: string): void
  mkdirp(dir: string): void
}

/** Real-fs implementation (mirrors `realCredentialsFs`). */
export const realLogtoSessionFs: LogtoSessionFs = {
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  write: (p, content, mode) => {
    fs.writeFileSync(p, content, { mode })
    try {
      fs.chmodSync(p, mode)
    } catch {
      // Best-effort — Windows ignores chmod.
    }
  },
  remove: (p) => {
    try {
      fs.unlinkSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  },
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true })
  },
}

/** Absolute path of the CLI's Logto session file inside the cognia home dir. */
export function logtoSessionPath(home: string): string {
  return path.join(home, "logto.json")
}

/** Persist (upsert) the active CLI Logto session with 0600 perms. */
export function writeLogtoSessionFile(
  home: string,
  session: LogtoSession,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): void {
  fsImpl.mkdirp(home)
  fsImpl.write(logtoSessionPath(home), JSON.stringify(session, null, 2), MODE_0600)
}

/** Load the active CLI Logto session, or `null` if absent / corrupt. */
export function readLogtoSessionFile(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): LogtoSession | null {
  const raw = fsImpl.read(logtoSessionPath(home))
  if (!raw) return null
  try {
    return JSON.parse(raw) as LogtoSession
  } catch {
    return null
  }
}

/** Remove the CLI Logto session file (sign out). Idempotent. */
export function removeLogtoSessionFile(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): void {
  fsImpl.remove(logtoSessionPath(home))
}
