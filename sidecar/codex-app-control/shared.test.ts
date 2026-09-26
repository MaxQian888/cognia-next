import assert from "node:assert/strict"
import test from "node:test"

import { relayPaths, waitFor, workerPath } from "./shared.ts"

test("relayPaths names the relaunch result and logs under the state dir", () => {
  assert.deepEqual(relayPaths("/state"), {
    root: "/state",
    cdpOnlyRelaunchResult: "/state/cdp-only-relaunch-result.json",
    cdpOnlyRelaunchStdout: "/state/cdp-only-relaunch-worker.stdout.log",
    cdpOnlyRelaunchStderr: "/state/cdp-only-relaunch-worker.stderr.log",
  })
})

test("workerPath resolves the launchd-spawned scripts next to this module", () => {
  assert.equal(
    workerPath("one-shot-launcher.mjs"),
    new URL("./one-shot-launcher.mjs", import.meta.url).pathname
  )
})

test("waitFor returns the first truthy value and names the condition on timeout", async () => {
  let calls = 0
  assert.equal(
    await waitFor(() => (++calls >= 2 ? "ready" : null), { timeoutMs: 1_000, intervalMs: 1 }),
    "ready"
  )
  await assert.rejects(
    waitFor(
      () => {
        throw new Error("probe failed")
      },
      { timeoutMs: 20, intervalMs: 5, description: "renderer" }
    ),
    /renderer did not become ready within 20ms: probe failed/
  )
})
