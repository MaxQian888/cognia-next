/**
 * Regression coverage for scripts/dev/free-port.mjs.
 *
 * The parsers and orchestration are exported with injectable exec/kill, so we
 * exercise them against canned command output — no real ports or processes.
 *
 * Run with: node --test scripts/dev/free-port.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parseUnixPids,
  parseWindowsPids,
  parseSsPids,
  parseFuserPids,
  findListenerPids,
  freePort,
} from "./free-port.mjs"

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
  // 3000 listeners only, deduped across IPv4/IPv6; ESTABLISHED + 3001 excluded.
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

test("findListenerPids dispatches netstat on windows", () => {
  const calls = []
  const exec = (cmd) => {
    calls.push(cmd)
    return "  TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 33"
  }
  assert.deepEqual(findListenerPids(3000, { platform: "win32", exec }), [33])
  assert.match(calls[0], /^netstat -ano -p tcp$/)
})

test("findListenerPids returns lsof results without falling back when lsof finds pids", () => {
  const calls = []
  const exec = (cmd) => {
    calls.push(cmd)
    return cmd.startsWith("lsof") ? "11\n22\n" : ""
  }
  assert.deepEqual(findListenerPids(3000, { platform: "linux", exec }), [11, 22])
  assert.deepEqual(calls, ["lsof -ti tcp:3000 -sTCP:LISTEN"]) // ss/fuser never invoked
})

test("findListenerPids cascades lsof -> ss -> fuser on linux when earlier tools are absent", () => {
  const calls = []
  const exec = (cmd) => {
    calls.push(cmd)
    if (cmd.startsWith("ss")) {
      return `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("next-server",pid=4242,fd=23))`
    }
    return "" // lsof missing, fuser not reached
  }
  assert.deepEqual(findListenerPids(3000, { platform: "linux", exec }), [4242])
  assert.deepEqual(calls, ["lsof -ti tcp:3000 -sTCP:LISTEN", "ss -lptnH sport = :3000"])
})

test("findListenerPids falls through to fuser when lsof and ss yield nothing", () => {
  const calls = []
  const exec = (cmd) => {
    calls.push(cmd)
    return cmd.startsWith("fuser") ? "3000/tcp: 9000" : ""
  }
  assert.deepEqual(findListenerPids(3000, { platform: "linux", exec }), [9000])
  assert.deepEqual(calls, [
    "lsof -ti tcp:3000 -sTCP:LISTEN",
    "ss -lptnH sport = :3000",
    "fuser 3000/tcp 2>&1",
  ])
})

test("freePort kills each discovered listener and reports them", () => {
  const killed = []
  const logs = []
  const result = freePort(3000, {
    platform: "darwin",
    exec: () => "100\n200\n",
    kill: (pid, platform) => killed.push([pid, platform]),
    log: (msg) => logs.push(msg),
  })
  assert.deepEqual(result.killed, [100, 200])
  assert.deepEqual(killed, [
    [100, "darwin"],
    [200, "darwin"],
  ])
  assert.match(logs[0], /killed 2 stale listener\(s\) on :3000/)
})

test("freePort is a no-op when the port is already free", () => {
  const killed = []
  const logs = []
  const result = freePort(3000, {
    platform: "darwin",
    exec: () => "",
    kill: (pid) => killed.push(pid),
    log: (msg) => logs.push(msg),
  })
  assert.deepEqual(result.killed, [])
  assert.deepEqual(killed, [])
  assert.match(logs[0], /:3000 is free/)
})
