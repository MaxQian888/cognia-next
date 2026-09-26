import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runGit } from "./git.ts"

test("runGit refuses anything but an argv array of strings", async () => {
  await assert.rejects(
    () => runGit("status" as unknown as string[], os.tmpdir()),
    /must be an array/
  )
  await assert.rejects(() => runGit(["log", 1], os.tmpdir()), /every git arg must be a string/)
})

test("runGit runs git in the given cwd with readable non-ASCII paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-git-"))
  try {
    await runGit(["init", "-q"], dir)
    // Every call carries `-c core.quotepath=false`, so git reports it as set.
    const { stdout } = await runGit(["config", "core.quotepath"], dir)
    assert.equal(stdout.trim(), "false")
    const top = await runGit(["rev-parse", "--show-toplevel"], dir)
    assert.equal(fs.realpathSync(top.stdout.trim()), fs.realpathSync(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runGit rejects on a failing git command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-git-fail-"))
  try {
    await assert.rejects(() => runGit(["rev-parse", "--git-dir"], dir), /not a git repository/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
