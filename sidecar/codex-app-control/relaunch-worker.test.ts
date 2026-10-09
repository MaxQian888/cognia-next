import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { parseRelaunchWorkerArgs, runCdpOnlyRelaunchWorker } from "./relaunch-worker.ts"
import { relayPaths } from "./shared.ts"

test("the worker reads the flags cdp-relaunch submits, with a 15s default delay", () => {
  assert.deepEqual(
    parseRelaunchWorkerArgs([
      "--state-dir",
      "/state",
      "--real-cli",
      "/app/codex",
      "--app-path",
      "/Applications/ChatGPT.app",
      "--cdp-port",
      "9229",
      "--delay-seconds",
      "0",
      "--attempt-id",
      "abc",
    ]),
    {
      stateDir: "/state",
      realCli: "/app/codex",
      appPath: "/Applications/ChatGPT.app",
      cdpPort: 9229,
      delaySeconds: 0,
      attemptId: "abc",
    }
  )
  const defaults = parseRelaunchWorkerArgs(["--cdp-port", "9229"])
  assert.equal(defaults.delaySeconds, 15)
  assert.equal(defaults.attemptId, null)
})

test("the worker refuses to run without a valid CDP port", () => {
  assert.throws(() => parseRelaunchWorkerArgs([]), /--cdp-port is required/)
  assert.throws(() => parseRelaunchWorkerArgs(["--cdp-port", "80"]), /Invalid CDP port: 80/)
  assert.throws(() => parseRelaunchWorkerArgs(["--cdp-port", "4318"]), /Invalid CDP port: 4318/)
})

test("the worker records a missing runtime and exits before requesting App exit", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-relaunch-preflight-"))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  assert.equal(
    await runCdpOnlyRelaunchWorker([
      "--state-dir",
      stateDir,
      "--real-cli",
      "/unavailable/codex-runtime",
      "--cdp-port",
      "9229",
      "--delay-seconds",
      "0",
    ]),
    1
  )
  const result = JSON.parse(readFileSync(relayPaths(stateDir).cdpOnlyRelaunchResult, "utf8"))
  assert.equal(result.status, "restart-cancelled-app-still-normal")
  assert.match(result.error, /Codex CLI is missing or not executable: \/unavailable\/codex-runtime/)
})
