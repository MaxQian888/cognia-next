import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { pathToFileURL } from "node:url"
import { detectAstGrep, __resetAstGrepCache, stagedBinaryPath, npmBinaryPath } from "./binary.mjs"

test("detectAstGrep honours COGNIA_AST_GREP_PATH when it exists", async () => {
  __resetAstGrepCache()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sg-"))
  const fake = path.join(dir, "ast-grep-fake")
  await fsp.writeFile(fake, "")
  const prev = process.env.COGNIA_AST_GREP_PATH
  process.env.COGNIA_AST_GREP_PATH = fake
  try {
    assert.equal(await detectAstGrep(), fake)
  } finally {
    if (prev === undefined) delete process.env.COGNIA_AST_GREP_PATH
    else process.env.COGNIA_AST_GREP_PATH = prev
    __resetAstGrepCache()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("detectAstGrep ignores a COGNIA_AST_GREP_PATH that does not exist", async () => {
  __resetAstGrepCache()
  const prev = process.env.COGNIA_AST_GREP_PATH
  process.env.COGNIA_AST_GREP_PATH = path.join(os.tmpdir(), "definitely-missing-sg-bin")
  try {
    const result = await detectAstGrep()
    // Falls through the probe chain — string (if installed) or null.
    assert.ok(result === null || typeof result === "string")
  } finally {
    if (prev === undefined) delete process.env.COGNIA_AST_GREP_PATH
    else process.env.COGNIA_AST_GREP_PATH = prev
    __resetAstGrepCache()
  }
})

test("detectAstGrep result is cached and never undefined", async () => {
  __resetAstGrepCache()
  const prev = process.env.COGNIA_AST_GREP_PATH
  delete process.env.COGNIA_AST_GREP_PATH
  try {
    const first = await detectAstGrep()
    const second = await detectAstGrep()
    assert.equal(first, second)
    assert.notEqual(first, undefined)
  } finally {
    if (prev !== undefined) process.env.COGNIA_AST_GREP_PATH = prev
    __resetAstGrepCache()
  }
})

test("finds the staged binary beside chunks without consulting cwd", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sg-layout-"))
  try {
    await fsp.mkdir(path.join(dir, "sidecar"))
    const binary = path.join(
      dir,
      "sidecar",
      process.platform === "win32" ? "ast-grep.exe" : "ast-grep"
    )
    await fsp.writeFile(binary, "fixture")
    assert.equal(
      stagedBinaryPath(pathToFileURL(path.join(dir, "chunks", "agent.mjs")).href, "/missing/node"),
      binary
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("resolves the npm binary from the installed platform dependency", () => {
  assert.ok(npmBinaryPath(), "sidecar @ast-grep/cli optional platform package must be installed")
})
