import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import test from "node:test"

import { smokeCliArtifact, smokeRunCodeRole } from "./cli-bun-artifact.mjs"

test("smokes the public CLI and every embedded standalone role", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-bun-smoke-"))
  const executable = path.join(root, "cli/dist/bin/cognia-agent-macos-arm64/cognia-agent")
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, "host")
  fs.chmodSync(executable, 0o755)

  const calls = []
  const responses = [
    { status: 0, stdout: "cognia-agent 1.0.0\n", stderr: "" },
    { status: 0, stdout: "2.1.227 (Claude Code)\n", stderr: "" },
    { status: 0, stdout: '{"ok":true}\n', stderr: "" },
    {
      status: 0,
      stdout: '{"type":"ready","sdkVersion":"0.3.227","sidecarVersion":"0.1.0"}\n',
      stderr: "",
    },
    {
      status: 1,
      stdout: '{"ok":false,"error":{"message":"Invalid job.mode: undefined"}}\n',
      stderr: "",
    },
    {
      status: 1,
      stdout: "",
      stderr: "cognia-tool-bridge: fatal: missing COGNIA_TOOLHOST_SOCKET / _TOKEN\n",
    },
    {
      status: 1,
      stdout: "",
      stderr: "MCP relay failed: invalid MCP relay configuration\n",
    },
  ]

  try {
    assert.equal(
      smokeCliArtifact(root, "darwin-arm64", {
        spawnSyncImpl(command, args, options) {
          calls.push({ command, args, options })
          return responses.shift()
        },
      }),
      executable
    )
    assert.deepEqual(
      calls.map(({ args, options }) => ({
        args,
        role: options.env.COGNIA_ROLE,
        input: options.input,
      })),
      [
        { args: ["--version"], role: undefined, input: undefined },
        { args: [], role: "claude-probe", input: undefined },
        { args: [], role: "codegraph-probe", input: undefined },
        { args: [], role: "sidecar", input: "" },
        { args: ["-"], role: "webclone", input: "{}" },
        { args: [], role: "tool-bridge", input: "" },
        { args: [], role: "mcp-relay", input: "" },
      ]
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("handshakes with the embedded run-code role over IPC", async () => {
  const sent = []
  class FakeChild extends EventEmitter {
    stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    send(message) {
      sent.push(message)
      queueMicrotask(() => this.emit("message", { kind: "done", result: 42 }))
    }
    kill() {}
  }

  await smokeRunCodeRole("/dist/cognia-agent", {
    spawnImpl(command, args, options) {
      assert.equal(command, "/dist/cognia-agent")
      assert.deepEqual(args, [])
      assert.equal(options.env.COGNIA_ROLE, "run-code")
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "ipc"])
      const child = new FakeChild()
      queueMicrotask(() => child.emit("message", { kind: "ready" }))
      return child
    },
  })

  assert.deepEqual(sent, [{ kind: "start", source: "return 6 * 7", toolNames: [] }])
})

test("smokes slim Claude resolution with an injected runtime and a sanitized failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-bun-smoke-"))
  const slimExecutable = path.join(root, "cli/dist/bin/cognia-agent-macos-arm64-slim/cognia-agent")
  const externalClaude = path.join(root, "cli/dist/bin/cognia-agent-macos-arm64/claude")
  fs.mkdirSync(path.dirname(slimExecutable), { recursive: true })
  fs.mkdirSync(path.dirname(externalClaude), { recursive: true })
  fs.writeFileSync(slimExecutable, "host")
  fs.writeFileSync(externalClaude, "claude")
  fs.chmodSync(slimExecutable, 0o755)
  fs.chmodSync(externalClaude, 0o755)
  const calls = []
  const responses = [
    { status: 0, stdout: "cognia-agent 1.0.0\n", stderr: "" },
    { status: 0, stdout: "2.1.227 (Claude Code)\n", stderr: "" },
    {
      status: 1,
      stdout: "",
      stderr: "Claude runtime is unavailable; set COGNIA_CLAUDE_EXECUTABLE",
    },
    { status: 0, stdout: '{"ok":true}\n', stderr: "" },
    { status: 0, stdout: '{"type":"ready"}\n', stderr: "" },
    {
      status: 1,
      stdout: '{"ok":false,"error":{"message":"Invalid job.mode: undefined"}}\n',
      stderr: "",
    },
    { status: 1, stdout: "", stderr: "missing COGNIA_TOOLHOST_SOCKET" },
    { status: 1, stdout: "", stderr: "invalid MCP relay configuration" },
  ]

  try {
    assert.equal(
      smokeCliArtifact(root, "darwin-arm64", {
        variant: "slim",
        externalClaudeExecutable: externalClaude,
        spawnSyncImpl(command, args, options) {
          calls.push({ command, args, options })
          return responses.shift()
        },
      }),
      slimExecutable
    )
    assert.equal(calls[1].options.env.COGNIA_CLAUDE_EXECUTABLE, externalClaude)
    assert.equal(calls[2].options.env.PATH, "")
    assert.equal("COGNIA_CLAUDE_EXECUTABLE" in calls[2].options.env, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("fails with the role name and subprocess diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-bun-smoke-"))
  const executable = path.join(root, "cli/dist/bin/cognia-agent-linux-x64/cognia-agent")
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, "host")
  fs.chmodSync(executable, 0o755)

  try {
    assert.throws(
      () =>
        smokeCliArtifact(root, "linux-x64", {
          spawnSyncImpl() {
            return { status: 2, stdout: "bad stdout", stderr: "bad stderr" }
          },
        }),
      /CLI version smoke failed.*bad stdout.*bad stderr/s
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
