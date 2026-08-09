/**
 * Regression coverage for scripts/dev/free-port.mjs.
 *
 * The parsers and orchestration are exported with injectable command execution
 * and process termination, so tests never touch real ports or processes.
 *
 * Run with: node --test scripts/dev/free-port.test.mjs
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  findListenerPids,
  freePort,
  parseFuserPids,
  parseSsPids,
  parseUnixPids,
  parseWindowsPids,
} from "./free-port.mjs"

const script = fileURLToPath(new URL("./free-port.mjs", import.meta.url))

function run(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test("documents the non-blocking port-release CLI", async () => {
  const result = await run(["--help"])

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /free-port\.mjs/)
  assert.match(result.stdout, /--port/)
  assert.match(result.stdout, /without ever blocking development startup/i)
})

test("reports invalid ports without aborting the development command", async () => {
  const result = await run(["--port", "not-a-port"])

  assert.equal(result.code, 0)
  assert.match(result.stderr, /skipped .*--port.*integer between 1 and 65535/i)
})

test("validates the legacy positional port accepted by Tauri's beforeDevCommand", async () => {
  const result = await run(["70000"])

  assert.equal(result.code, 0)
  assert.match(result.stderr, /skipped .*integer between 1 and 65535/i)
})

test("parseUnixPids splits lines, dedupes, and drops non-numeric noise", () => {
  assert.deepEqual(parseUnixPids("123\n456\n123\n"), [123, 456])
  assert.deepEqual(parseUnixPids(""), [])
  assert.deepEqual(parseUnixPids("  \n789\n"), [789])
})

test("parseWindowsPids keeps only LISTENING rows matching :port and reads the PID column", () => {
  const stdout = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242",
    "  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       9999",
    "  TCP    127.0.0.1:3000         127.0.0.1:55012       ESTABLISHED     7777",
    "  TCP    [::]:3000              [::]:0                LISTENING       4242",
  ].join("\r\n")
  assert.deepEqual(parseWindowsPids(stdout, 3000), [4242])
  assert.deepEqual(parseWindowsPids(stdout, 3001), [9999])
  assert.deepEqual(parseWindowsPids("", 3000), [])
})

test("parseSsPids extracts every pid= occurrence and dedupes", () => {
  const stdout = [
    `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("next-server",pid=1234,fd=23))`,
    `LISTEN 0 511 [::]:3000 [::]:* users:(("next-server",pid=1234,fd=24),("node",pid=5678,fd=9))`,
  ].join("\n")
  assert.deepEqual(parseSsPids(stdout), [1234, 5678])
  assert.deepEqual(parseSsPids(""), [])
})

test("parseFuserPids strips the port label and reads the pid list", () => {
  assert.deepEqual(parseFuserPids("3000/tcp:        1234  5678"), [1234, 5678])
  assert.deepEqual(parseFuserPids("3000/tcp: 1234"), [1234])
  assert.deepEqual(parseFuserPids(""), [])
})

test("findListenerPids dispatches netstat on windows", async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push({ command, args })
    return "  TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 33"
  }

  assert.deepEqual(await findListenerPids(3000, { platform: "win32", exec }), [33])
  assert.deepEqual(calls, [{ command: "netstat", args: ["-ano", "-p", "tcp"] }])
})

test("findListenerPids returns lsof results without falling back when lsof finds pids", async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push({ command, args })
    return command === "lsof" ? "11\n22\n" : ""
  }

  assert.deepEqual(await findListenerPids(3000, { platform: "linux", exec }), [11, 22])
  assert.deepEqual(calls, [{ command: "lsof", args: ["-ti", "tcp:3000", "-sTCP:LISTEN"] }])
})

test("findListenerPids cascades lsof -> ss -> fuser on linux when earlier tools are absent", async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push({ command, args })
    if (command === "ss") {
      return `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("next-server",pid=4242,fd=23))`
    }
    return ""
  }

  assert.deepEqual(await findListenerPids(3000, { platform: "linux", exec }), [4242])
  assert.deepEqual(calls, [
    { command: "lsof", args: ["-ti", "tcp:3000", "-sTCP:LISTEN"] },
    { command: "ss", args: ["-lptnH", "sport", "=", ":3000"] },
  ])
})

test("findListenerPids falls through to fuser when lsof and ss yield nothing", async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push({ command, args })
    return command === "fuser" ? "3000/tcp: 9000" : ""
  }

  assert.deepEqual(await findListenerPids(3000, { platform: "linux", exec }), [9000])
  assert.deepEqual(calls, [
    { command: "lsof", args: ["-ti", "tcp:3000", "-sTCP:LISTEN"] },
    { command: "ss", args: ["-lptnH", "sport", "=", ":3000"] },
    { command: "fuser", args: ["3000/tcp"] },
  ])
})

test("freePort kills each discovered listener and reports them", async () => {
  const killed = []
  const logs = []
  const result = await freePort(3000, {
    platform: "darwin",
    exec: async () => "100\n200\n",
    kill: async (pid, platform) => killed.push([pid, platform]),
    log: (message) => logs.push(message),
  })

  assert.deepEqual(result.killed, [100, 200])
  assert.deepEqual(killed, [
    [100, "darwin"],
    [200, "darwin"],
  ])
  assert.match(logs[0], /killed 2 stale listener\(s\) on :3000/)
})

test("freePort is a no-op when the port is already free", async () => {
  const killed = []
  const logs = []
  const result = await freePort(3000, {
    platform: "darwin",
    exec: async () => "",
    kill: async (pid) => killed.push(pid),
    log: (message) => logs.push(message),
  })

  assert.deepEqual(result.killed, [])
  assert.deepEqual(killed, [])
  assert.match(logs[0], /:3000 is free/)
})
