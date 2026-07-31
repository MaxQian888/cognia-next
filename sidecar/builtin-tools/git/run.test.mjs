import { test } from "node:test"
import assert from "node:assert/strict"

import { assertRepo, resetRepoCache, trimTail } from "./run.mjs"

test("assertRepo rejects empty cwd", async () => {
  await assert.rejects(() => assertRepo(""), /cwd/)
})

test("assertRepo validates a repo and caches the result (no re-spawn on repeat)", async () => {
  resetRepoCache()
  // The sidecar dir is inside the cognia-next repo, so validation succeeds.
  const cwd = process.cwd()
  await assertRepo(cwd) // validates (spawns git)
  await assertRepo(cwd) // cache hit — returns without spawning
  resetRepoCache()
  await assertRepo(cwd) // re-validates cleanly after a reset
})

test("trimTail leaves short strings alone and truncates long ones", () => {
  const short = "x".repeat(10)
  assert.deepEqual(trimTail(short, 100), { text: short, truncated: false })
  const long = "y".repeat(500)
  const t = trimTail(long, 50)
  assert.equal(t.truncated, true)
  assert.match(t.text, /truncated/)
})
