import assert from "node:assert/strict"
import test from "node:test"

import { buildDetachedCdpRelaunch, scheduleDetachedCdpRelaunch } from "./cdp-relaunch.mjs"

test("detached relaunch submits the worker before the App is asked to quit", () => {
  const submission = buildDetachedCdpRelaunch({
    attemptId: "attempt-123",
    stateDir: "/tmp/cognia-test",
    appPath: "/Applications/ChatGPT.app",
    realCli: "/Applications/ChatGPT.app/Contents/Resources/codex",
    cdpPort: 9229,
    label: "com.cognia.test",
  })

  assert.deepEqual(submission.launchArgs.slice(0, 5), [
    "submit",
    "-l",
    "com.cognia.test",
    "-o",
    "/tmp/cognia-test/cdp-only-relaunch-worker.stdout.log",
  ])
  assert.ok(
    submission.launchArgs.some((argument) => argument.endsWith("cdp-only-relaunch-worker.mjs"))
  )
  assert.ok(submission.launchArgs.includes("--attempt-id"))
  assert.ok(submission.launchArgs.includes("attempt-123"))
})

test("scheduler waits for the matching detached worker readiness record", async () => {
  let state = null
  const commands = []
  const result = await scheduleDetachedCdpRelaunch(
    { stateDir: "/tmp/cognia-test", cdpPort: 9229 },
    {
      launchctlJobExists: () => false,
      ensurePrivateDirectory: async () => {},
      writeJsonAtomic: async (_path, value) => {
        state = value
      },
      commandResult: (command, args) => {
        commands.push([command, ...args])
        state = { ...state, status: "ready", renderer: { id: "codex-renderer" } }
        return { ok: true, stdout: "", stderr: "", error: null }
      },
      readJson: async () => state,
      waitFor: async (predicate) => predicate(),
    }
  )

  assert.equal(result.status, "ready")
  assert.equal(result.renderer.id, "codex-renderer")
  assert.equal(result.reused, false)
  assert.equal(commands.length, 1)
  assert.equal(commands[0][0], "/bin/launchctl")
})

test("scheduler joins an already active relaunch instead of submitting another", async () => {
  const active = { status: "armed", attemptId: "existing-attempt" }
  let reads = 0
  const result = await scheduleDetachedCdpRelaunch(
    { stateDir: "/tmp/cognia-test", cdpPort: 9229 },
    {
      launchctlJobExists: () => true,
      readJson: async () => {
        reads += 1
        return reads === 1 ? active : { ...active, status: "ready" }
      },
      waitFor: async (predicate) => predicate(),
      commandResult: () => {
        throw new Error("must not submit a second relaunch")
      },
    }
  )

  assert.equal(result.reused, true)
  assert.equal(result.attemptId, "existing-attempt")
})
