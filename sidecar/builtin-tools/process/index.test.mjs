import { test } from "node:test"
import assert from "node:assert/strict"

import { processTools, PROCESS_TOOL_NAMES, __testExports } from "./index.mjs"
import { trackedPids } from "./inventory.mjs"

test("processTools registration order is byte-stable", () => {
  assert.deepEqual(
    processTools.map((t) => t.name),
    [...PROCESS_TOOL_NAMES]
  )
})

test("processTools exposes all 9 process tools", () => {
  assert.equal(processTools.length, 9)
})

test("__testExports.trackedPids is the single shared inventory instance", () => {
  assert.equal(__testExports.trackedPids, trackedPids)
})

test("__testExports exposes every handler + helper", () => {
  for (const key of [
    "execListProcesses",
    "execGetProcess",
    "execSearchProcesses",
    "execTopMemoryProcesses",
    "execCheckProgramAllowed",
    "execGetProcessManagerStatus",
    "execGetTrackedProcesses",
    "execStartProcess",
    "execTerminateProcess",
    "parsePosixPs",
    "parseWindowsCsv",
    "parseCsvRow",
    "isProgramAllowed",
    "formatProcess",
    "pickField",
    "compareBy",
  ]) {
    assert.equal(typeof __testExports[key], "function", `missing ${key}`)
  }
})
