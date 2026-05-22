import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { __testExports } from "../terminal-dock-tool.mjs"

const { execSpawn, execWrite, execReadRecent, execWaitForExit, reset } = __testExports

let TMP

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-dock-tool-"))
})

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  reset()
})

function decode(r) {
  return JSON.parse(r.content[0].text)
}

const SHELL = process.platform === "win32" ? "pwsh.exe" : "/bin/bash"

test("execSpawn returns a session id when cwd exists", async () => {
  const r = await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP })
  assert.equal(r.isError, undefined)
  const out = decode(r)
  assert.ok(out.sessionId)
})

test("execSpawn errors when cwd does not exist", async () => {
  const r = await execSpawn({
    agentId: "a",
    shell: SHELL,
    cwd: path.join(TMP, "does-not-exist"),
  })
  assert.equal(r.isError, true)
})

test("execWrite runs a command and returns exit code 0 for `true`-equivalent", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  const cmd = process.platform === "win32" ? "exit 0" : "true"
  const r = await execWrite({
    agentId: "a",
    sessionId: spawn.sessionId,
    command: cmd,
    timeoutMs: 5000,
  })
  const out = decode(r)
  assert.equal(out.exitCode, 0)
})

test("execWrite captures stdout", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  const cmd = process.platform === "win32" ? "Write-Output hello" : "echo hello"
  const r = await execWrite({
    agentId: "a",
    sessionId: spawn.sessionId,
    command: cmd,
    timeoutMs: 5000,
  })
  const out = decode(r)
  assert.match(out.stdout, /hello/)
  assert.equal(out.exitCode, 0)
})

test("execWrite rejects when the calling agentId doesn't own the session", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  const r = await execWrite({
    agentId: "evil",
    sessionId: spawn.sessionId,
    command: "echo no",
    timeoutMs: 1000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /another agent/i)
})

test("execWrite returns isError-free response when the session id is unknown", async () => {
  const r = await execWrite({
    agentId: "a",
    sessionId: "ghost",
    command: "echo x",
    timeoutMs: 1000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /unknown session/i)
})

test("execReadRecent returns the history slice", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  for (const cmd of ["echo one", "echo two", "echo three"]) {
    await execWrite({
      agentId: "a",
      sessionId: spawn.sessionId,
      command: cmd,
      timeoutMs: 5000,
    })
  }
  const r = await execReadRecent({
    agentId: "a",
    sessionId: spawn.sessionId,
    lineLimit: 2,
  })
  const out = decode(r)
  assert.equal(out.length, 2)
  assert.match(out[1].cmd, /three/)
})

test("execReadRecent rejects when the calling agentId differs", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  const r = await execReadRecent({
    agentId: "evil",
    sessionId: spawn.sessionId,
    lineLimit: 1,
  })
  assert.equal(r.isError, true)
})

test("execWaitForExit returns pending when no commands have run yet", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  const r = await execWaitForExit({
    agentId: "a",
    sessionId: spawn.sessionId,
    timeoutMs: 1000,
  })
  const out = decode(r)
  assert.equal(out.pending, true)
})

test("execWaitForExit returns the last record after a command", async () => {
  const spawn = decode(await execSpawn({ agentId: "a", shell: SHELL, cwd: TMP }))
  const cmd = process.platform === "win32" ? "exit 0" : "true"
  await execWrite({
    agentId: "a",
    sessionId: spawn.sessionId,
    command: cmd,
    timeoutMs: 5000,
  })
  const r = await execWaitForExit({
    agentId: "a",
    sessionId: spawn.sessionId,
    timeoutMs: 1000,
  })
  const out = decode(r)
  assert.equal(out.exitCode, 0)
})
