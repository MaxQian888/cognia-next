import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { AgentSupervisor } from "./supervisor.mjs"

test("supervisor supports repeated agent spawn/send/status/kill", async () => {
  const events = []
  const supervisor = new AgentSupervisor({ onEvent: (event) => events.push(event) })
  const script = [
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', data => process.stdout.write('echo:' + data))",
  ].join(";")

  await supervisor.spawn({ id: "agent-1", command: process.execPath, args: ["-e", script] })
  assert.equal(supervisor.status("agent-1").state, "running")
  await supervisor.send("agent-1", "ping\n")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert(events.some((event) => event.type === "stdout" && event.data.includes("echo:ping")))
  await supervisor.kill("agent-1")
  assert.equal(supervisor.status("agent-1").state, "stopped")

  await supervisor.spawn({
    id: "agent-2",
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
  })
  await supervisor.killAll()
  assert.equal(supervisor.status("agent-2").state, "stopped")
})

test("supervisor never inherits runtime secrets into agent children", async () => {
  const events = []
  const supervisor = new AgentSupervisor({
    hostEnv: {
      PATH: process.env.PATH,
      HOME: "/home/pwuser",
      LANG: "C.UTF-8",
      COGNIA_WORKSPACE_RUNTIME_SECRET: "must-not-cross-boundary",
      UNRELATED_HOST_SECRET: "also-private",
    },
    onEvent: (event) => events.push(event),
  })
  const script = "process.stdout.write(JSON.stringify(process.env))"

  await supervisor.spawn({
    id: "agent-env",
    command: process.execPath,
    args: ["-e", script],
    env: { EXPLICIT_AGENT_VALUE: "allowed" },
  })
  await new Promise((resolve) => {
    const poll = () => {
      if (supervisor.status("agent-env").state === "stopped") resolve()
      else setTimeout(poll, 10)
    }
    poll()
  })
  const output = events
    .filter((event) => event.type === "stdout")
    .map((event) => event.data)
    .join("")
  const childEnv = JSON.parse(output)

  assert.equal(childEnv.PATH, process.env.PATH)
  assert.equal(childEnv.HOME, "/home/pwuser")
  assert.equal(childEnv.EXPLICIT_AGENT_VALUE, "allowed")
  assert.equal(childEnv.COGNIA_WORKSPACE_RUNTIME_SECRET, undefined)
  assert.equal(childEnv.UNRELATED_HOST_SECRET, undefined)
})

test("supervisor rejects a workspace symlink that escapes the mounted root", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-supervisor-workspace-"))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-supervisor-outside-"))
  t.after(() =>
    Promise.all([fs.rm(workspace, { recursive: true }), fs.rm(outside, { recursive: true })])
  )
  await fs.symlink(outside, path.join(workspace, "escape"))
  const supervisor = new AgentSupervisor({ workspaceRoot: workspace })

  await assert.rejects(
    () =>
      supervisor.spawn({
        id: "escaped",
        command: process.execPath,
        cwd: path.join(workspace, "escape"),
      }),
    /outside workspace/
  )
})
