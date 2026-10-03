// `vscode.env`'s fixed values: the default shell and the telemetry logger.
import assert from "node:assert/strict"
import { test } from "node:test"

import { createTelemetryLogger, defaultShell } from "../dist/vscode-shim/env.js"

test("the default shell is the login shell, or the command interpreter on Windows", () => {
  assert.equal(defaultShell("darwin", { SHELL: "/bin/zsh" }), "/bin/zsh")
  assert.equal(defaultShell("linux", {}), "/bin/sh")
  assert.equal(
    defaultShell("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }),
    "C:\\Windows\\system32\\cmd.exe"
  )
  assert.equal(defaultShell("win32", {}), "cmd.exe")
})

test("telemetry is off: the logger sends nothing, and dispose flushes once", async () => {
  const calls = []
  const sender = {
    sendEventData: (...args) => calls.push(["event", ...args]),
    sendErrorData: (...args) => calls.push(["error", ...args]),
    flush: () => calls.push(["flush"]),
  }
  const logger = createTelemetryLogger(sender)
  assert.deepEqual([logger.isUsageEnabled, logger.isErrorsEnabled], [false, false])
  logger.onDidChangeEnableStates(() => assert.fail("fired"))
  logger.logUsage("opened", { file: "a" })
  logger.logError(new Error("boom"))
  logger.logError("failed")
  await logger.dispose()
  await logger.dispose()
  assert.deepEqual(calls, [["flush"]])
})

test("a sender without the required methods is refused", () => {
  assert.throws(() => createTelemetryLogger({ sendEventData() {} }), /sendErrorData/)
})
