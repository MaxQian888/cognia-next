import { test } from "node:test"
import assert from "node:assert/strict"

import { fileExtrasTools, FILE_EXTRAS_TOOL_NAMES, __testExports } from "./index.mjs"

test("fileExtrasTools registration order is byte-stable", () => {
  assert.deepEqual(
    fileExtrasTools.map((t) => t.name),
    [...FILE_EXTRAS_TOOL_NAMES]
  )
})

test("fileExtrasTools exposes all 13 file-extras tools", () => {
  assert.equal(fileExtrasTools.length, 13)
})

test("__testExports exposes every handler + mimeForPath", () => {
  for (const key of [
    "execFileHash",
    "execFileDiff",
    "execFileInfo",
    "execFileExists",
    "execFileSearch",
    "execContentSearch",
    "execFileAppend",
    "execFileBinaryWrite",
    "execFileCopy",
    "execFileRename",
    "execFileMove",
    "execDirectoryCreate",
    "execDirectoryDelete",
    "mimeForPath",
  ]) {
    assert.equal(typeof __testExports[key], "function", `missing ${key}`)
  }
})

test("mimeForPath maps known extensions (parity with legacy file-extras)", () => {
  assert.equal(__testExports.mimeForPath("a.json"), "application/json")
  assert.equal(__testExports.mimeForPath("a.unknown"), "application/octet-stream")
})
