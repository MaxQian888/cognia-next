// One runner per (platform, conversation).
//
// Two runners in the same chat break each other in ways that look like product
// bugs: run A's assertion can be satisfied by run B's reply, the duplicate
// window sees B's message and reports a Bot loop, and on Lark a second
// long-connection consumer for the same App ID gets a random half of the
// events (the platform load-balances, it does not broadcast).
//
// The lock is a file created with the `wx` flag, which is atomic on every
// platform we support. A stale lock — a runner that crashed without releasing
// — is stolen after `ttlMs`, because the alternative is a repo that needs
// manual cleanup after every Ctrl-C.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

export class LockHeldError extends Error {
  constructor(message, holder) {
    super(message)
    this.name = "LockHeldError"
    this.holder = holder
  }
}

/** Stable, filesystem-safe name for a conversation id of any shape. */
export function lockFileName(platform, conversationId) {
  const digest = createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 16)
  return `${platform}-${digest}.lock`
}

export function lockDir(outputDir) {
  return path.join(outputDir, ".locks")
}

/**
 * Take the lock for one conversation.
 *
 * Returns a handle whose `release()` is idempotent and never removes a lock
 * that another runner has since taken over — after a steal, two processes
 * believe they hold the same path, and a blind unlink would hand the chat to a
 * third.
 */
export function acquireLock({
  outputDir,
  platform,
  conversationId,
  runId,
  ttlMs,
  now = Date.now,
  pid = process.pid,
  fs = { mkdirSync, readFileSync, writeFileSync, unlinkSync },
}) {
  const dir = lockDir(outputDir)
  const file = path.join(dir, lockFileName(platform, conversationId))
  fs.mkdirSync(dir, { recursive: true })

  const payload = { pid, platform, conversationId, runId, acquiredAt: now() }
  const write = () => fs.writeFileSync(file, JSON.stringify(payload), { flag: "wx" })

  try {
    write()
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    const holder = readHolder(fs, file)
    const ageMs = holder?.acquiredAt ? now() - holder.acquiredAt : Infinity
    if (ageMs <= ttlMs) {
      throw new LockHeldError(
        `${platform}/${conversationId} is already being driven by pid ${holder?.pid ?? "?"} ` +
          `(run ${holder?.runId ?? "?"}, held ${Math.round(ageMs / 1000)}s). ` +
          `Wait for it, or remove ${file} if that process is gone.`,
        holder
      )
    }
    // Stale: the previous runner died. Steal it, then fail loudly if a third
    // process won the same race — retrying forever would livelock.
    try {
      fs.unlinkSync(file)
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError
    }
    payload.acquiredAt = now()
    payload.stoleFrom = holder?.pid ?? null
    write()
  }

  let released = false
  return {
    file,
    payload,
    stoleFrom: payload.stoleFrom ?? null,
    release() {
      if (released) return
      released = true
      const current = readHolder(fs, file)
      // Only ours to remove. After a steal the old handle must not delete the
      // new owner's lock.
      if (current && current.pid === payload.pid && current.acquiredAt === payload.acquiredAt) {
        try {
          fs.unlinkSync(file)
        } catch (error) {
          if (error?.code !== "ENOENT") throw error
        }
      }
    },
  }
}

function readHolder(fs, file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    // Unreadable or truncated: treat as an unknown holder with no timestamp,
    // which makes it stale and therefore stealable.
    return null
  }
}
