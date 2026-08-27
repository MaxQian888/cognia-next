import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { LockHeldError, acquireLock, lockDir, lockFileName } from "./lock.mjs"

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "cognia-im-live-lock-"))
}

const TTL = 30 * 60 * 1000

test("lockFileName is filesystem-safe for ids containing separators", () => {
  const name = lockFileName("matrix", "!room:example.org/../../etc/passwd")
  assert.match(name, /^matrix-[0-9a-f]{16}\.lock$/)
  assert.ok(!name.includes("/"))
})

test("lockFileName is stable and conversation-specific", () => {
  assert.equal(lockFileName("lark", "oc_1"), lockFileName("lark", "oc_1"))
  assert.notEqual(lockFileName("lark", "oc_1"), lockFileName("lark", "oc_2"))
  assert.notEqual(lockFileName("lark", "oc_1"), lockFileName("slack", "oc_1"))
})

test("acquire then release leaves no lock behind", () => {
  const outputDir = scratch()
  const lock = acquireLock({
    outputDir,
    platform: "slack",
    conversationId: "C1",
    runId: "r1",
    ttlMs: TTL,
  })
  assert.equal(readdirSync(lockDir(outputDir)).length, 1)
  lock.release()
  assert.equal(readdirSync(lockDir(outputDir)).length, 0)
})

test("release is idempotent", () => {
  const outputDir = scratch()
  const lock = acquireLock({
    outputDir,
    platform: "slack",
    conversationId: "C1",
    runId: "r1",
    ttlMs: TTL,
  })
  lock.release()
  lock.release()
  assert.equal(readdirSync(lockDir(outputDir)).length, 0)
})

test("a second runner on the same conversation is refused, and told who holds it", () => {
  const outputDir = scratch()
  acquireLock({
    outputDir,
    platform: "lark",
    conversationId: "oc_x",
    runId: "first",
    ttlMs: TTL,
    pid: 4242,
  })
  assert.throws(
    () =>
      acquireLock({
        outputDir,
        platform: "lark",
        conversationId: "oc_x",
        runId: "second",
        ttlMs: TTL,
      }),
    (error) => {
      assert.ok(error instanceof LockHeldError)
      assert.match(error.message, /pid 4242/)
      assert.match(error.message, /run first/)
      assert.equal(error.holder.pid, 4242)
      return true
    }
  )
})

test("a different conversation on the same platform is not blocked", () => {
  const outputDir = scratch()
  acquireLock({ outputDir, platform: "lark", conversationId: "oc_a", runId: "a", ttlMs: TTL })
  const other = acquireLock({
    outputDir,
    platform: "lark",
    conversationId: "oc_b",
    runId: "b",
    ttlMs: TTL,
  })
  assert.ok(other.file.endsWith(".lock"))
})

test("a lock older than the TTL is stolen, and the theft is recorded", () => {
  const outputDir = scratch()
  let clock = 1_000_000
  acquireLock({
    outputDir,
    platform: "telegram",
    conversationId: "555",
    runId: "dead",
    ttlMs: TTL,
    pid: 999,
    now: () => clock,
  })
  clock += TTL + 1
  const taken = acquireLock({
    outputDir,
    platform: "telegram",
    conversationId: "555",
    runId: "alive",
    ttlMs: TTL,
    pid: 1000,
    now: () => clock,
  })
  assert.equal(taken.stoleFrom, 999)
  assert.equal(taken.payload.runId, "alive")
})

test("a lock exactly at the TTL is still held — the boundary does not steal", () => {
  const outputDir = scratch()
  let clock = 500
  acquireLock({
    outputDir,
    platform: "discord",
    conversationId: "c",
    runId: "one",
    ttlMs: TTL,
    now: () => clock,
  })
  clock += TTL
  assert.throws(
    () =>
      acquireLock({
        outputDir,
        platform: "discord",
        conversationId: "c",
        runId: "two",
        ttlMs: TTL,
        now: () => clock,
      }),
    LockHeldError
  )
})

test("a corrupt lock file is treated as stale and stolen", () => {
  const outputDir = scratch()
  const first = acquireLock({
    outputDir,
    platform: "matrix",
    conversationId: "!r:h",
    runId: "one",
    ttlMs: TTL,
  })
  writeFileSync(first.file, "{ truncated")
  const second = acquireLock({
    outputDir,
    platform: "matrix",
    conversationId: "!r:h",
    runId: "two",
    ttlMs: TTL,
  })
  assert.equal(second.payload.runId, "two")
})

test("the stolen-from runner's release does not evict the new owner", () => {
  const outputDir = scratch()
  let clock = 10
  const stale = acquireLock({
    outputDir,
    platform: "slack",
    conversationId: "C9",
    runId: "old",
    ttlMs: TTL,
    pid: 1,
    now: () => clock,
  })
  clock += TTL + 1
  acquireLock({
    outputDir,
    platform: "slack",
    conversationId: "C9",
    runId: "new",
    ttlMs: TTL,
    pid: 2,
    now: () => clock,
  })
  stale.release()
  assert.equal(readdirSync(lockDir(outputDir)).length, 1, "the new owner's lock must survive")
})
