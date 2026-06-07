// Session-scoped read tracker for the core file tools.
//
// `write` / `edit` / `multi_edit` enforce a read-before-write contract: the
// agent must have `read` a file in this session (and the file must not have
// changed on disk since) before it may overwrite or edit it. This mirrors
// Claude Code's Read-before-Edit enforcement and prevents blind clobbers of
// files the model has never seen (or that changed under it).
//
// One tracker is created per dispatch session and threaded into the core
// tool defs by `core-tools.mjs`.

import path from "node:path"

/**
 * Canonicalise a path for map keying: resolve, and on Windows lower-case the
 * drive letter so `c:\x` and `C:\x` collide as intended. We intentionally do
 * NOT lower-case the whole path — most win32 filesystems are case-insensitive
 * but case-preserving, and tools always pass back the path they were given.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalKey(p) {
  const abs = path.resolve(p)
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(abs)) {
    return abs[0].toLowerCase() + abs.slice(1)
  }
  return abs
}

/**
 * @returns {{
 *   record: (absPath: string, stat: { mtimeMs: number, size: number }) => void,
 *   hasRead: (absPath: string) => boolean,
 *   assertReadBefore: (absPath: string, stat: { mtimeMs: number, size: number }) => void,
 *   clear: () => void,
 * }}
 */
export function createReadTracker() {
  /** @type {Map<string, { mtimeMs: number, size: number }>} */
  const seen = new Map()

  return {
    record(absPath, stat) {
      seen.set(canonicalKey(absPath), { mtimeMs: stat.mtimeMs, size: stat.size })
    },

    hasRead(absPath) {
      return seen.has(canonicalKey(absPath))
    },

    /**
     * Throws with agent-actionable guidance when the file was never read this
     * session, or when it changed on disk since the recorded read (mtime
     * mismatch — equal mtimes are treated as fresh to tolerate coarse
     * filesystem timestamp granularity).
     */
    assertReadBefore(absPath, stat) {
      const rec = seen.get(canonicalKey(absPath))
      if (!rec) {
        throw new Error(
          `File has not been read yet: ${absPath}. Use the read tool on it first, then retry.`
        )
      }
      if (rec.mtimeMs !== stat.mtimeMs) {
        throw new Error(
          `File changed on disk since it was last read: ${absPath}. Re-read it to get the current content, then retry.`
        )
      }
    },

    clear() {
      seen.clear()
    },
  }
}
