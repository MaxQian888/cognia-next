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

test("assertRepo reports subprocess health failures instead of mislabeling the directory", async () => {
  resetRepoCache()
  const brokenGit = async () => {
    throw new Error(
      "fatal: could not open '/dev/null' for reading and writing: Operation not permitted"
    )
  }
  await assert.rejects(
    () => assertRepo("/workspace", brokenGit),
    (err) => {
      assert.match(err.message, /git subprocess health check failed/i)
      assert.doesNotMatch(err.message, /not a git repository/i)
      assert.match(err.message, /restart/i)
      return true
    }
  )
})

test("trimTail leaves short strings alone and truncates long ones", () => {
  const short = "x".repeat(10)
  assert.deepEqual(trimTail(short, 100), { text: short, truncated: false })
  const long = "y".repeat(500)
  const t = trimTail(long, 50)
  assert.equal(t.truncated, true)
  assert.match(t.text, /truncated/)
})
