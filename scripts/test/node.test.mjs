import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import { forwardedNodeTestArgs } from "./node.mjs"

const runner = fileURLToPath(new URL("./node.mjs", import.meta.url))

test("bounds file workers on large hosts and leaves a worker on small hosts", () => {
  assert.deepEqual(forwardedNodeTestArgs(["a.test.mjs"], {}, 14), [
    "--test",
    "--test-concurrency=2",
    "a.test.mjs",
  ])
  for (const cpus of [1, 2]) {
    assert.equal(forwardedNodeTestArgs([], {}, cpus)[1], "--test-concurrency=1")
  }
})

test("preserves selections and reporters while resolving CLI over environment over default", () => {
  const args = ["--", "--test-reporter=spec", "a.test.mjs", "b.test.mjs"]
  assert.deepEqual(forwardedNodeTestArgs(args, { NODE_TEST_CONCURRENCY: "3" }), [
    "--test",
    "--test-concurrency=3",
    ...args.slice(1),
  ])
  for (const flag of [["--test-concurrency=4"], ["--test-concurrency", "4"]]) {
    assert.deepEqual(
      forwardedNodeTestArgs([...flag, "a.test.mjs"], { NODE_TEST_CONCURRENCY: "invalid" }),
      ["--test", ...flag, "a.test.mjs"]
    )
  }
  assert.deepEqual(forwardedNodeTestArgs(["a.test.mjs", "--", "--test-concurrency=9"], {}, 14), [
    "--test",
    "--test-concurrency=2",
    "a.test.mjs",
    "--",
    "--test-concurrency=9",
  ])
})

test("rejects invalid environment limits rather than silently launching an unbounded pool", () => {
  for (const value of ["", "0", "-1", "1.5", "2x", " 2", "Infinity", "9007199254740992"]) {
    assert.throws(
      () => forwardedNodeTestArgs([], { NODE_TEST_CONCURRENCY: value }),
      /positive safe integer/
    )
  }
})

test("the real runner bounds concurrent files, runs every file and propagates failures", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "node-test-budget-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const events = path.join(root, "events.jsonl")
  const files = Array.from({ length: 4 }, (_, i) => {
    const file = path.join(root, `${i}.test.mjs`)
    writeFileSync(
      file,
      `import {test} from 'node:test'; import {appendFileSync} from 'node:fs';
test('fixture ${i}',async()=>{appendFileSync(process.env.BUDGET_EVENTS,JSON.stringify({id:${i},delta:1})+'\\n');
await new Promise(resolve=>setTimeout(resolve,100));
appendFileSync(process.env.BUDGET_EVENTS,JSON.stringify({id:${i},delta:-1})+'\\n');});`
    )
    return file
  })
  for (const [limit, flags, bound] of [
    [undefined, [], 2],
    ["1", [], 1],
    ["invalid", ["--test-concurrency=1"], 1],
  ]) {
    writeFileSync(events, "")
    const env = { ...process.env, BUDGET_EVENTS: events }
    // A new top-level runner must not inherit the outer test child's marker.
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_TEST_CONCURRENCY
    if (limit) env.NODE_TEST_CONCURRENCY = limit
    const run = spawnSync(process.execPath, [runner, "--", ...flags, ...files], {
      env,
      encoding: "utf8",
      timeout: 20000,
    })
    assert.equal(run.status, 0, run.stderr + run.stdout)
    let active = 0
    let peak = 0
    const seen = new Set()
    for (const { id, delta } of readFileSync(events, "utf8").trim().split("\n").map(JSON.parse)) {
      active += delta
      peak = Math.max(peak, active)
      if (delta === 1) seen.add(id)
    }
    assert.equal(seen.size, files.length)
    assert.equal(active, 0)
    assert.ok(peak <= bound, `Observed ${peak} concurrent test files`)
  }
  const failed = path.join(root, "failed.test.mjs")
  writeFileSync(
    failed,
    "import {test} from 'node:test';test('intentional failure',()=>{throw new Error('fixture failure')});"
  )
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_CONCURRENCY
  const run = spawnSync(process.execPath, [runner, failed], {
    env,
    encoding: "utf8",
    timeout: 20000,
  })
  assert.equal(run.status, 1)
  assert.match(run.stdout, /fixture failure/)
})

test(
  "signalling only the wrapper terminates its runner and test worker",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "node-test-signal-"))
    const workerPidFile = path.join(root, "worker.pid")
    const file = path.join(root, "waiting.test.mjs")
    writeFileSync(
      file,
      `import {test} from 'node:test';import {writeFileSync} from 'node:fs';
test('waiting',async()=>{writeFileSync(process.env.WORKER_PID_FILE,String(process.pid));
await new Promise(resolve=>setTimeout(resolve,30000));});`
    )
    const env = { ...process.env, WORKER_PID_FILE: workerPidFile }
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_TEST_CONCURRENCY
    const child = spawn(process.execPath, [runner, file], { env, stdio: "ignore" })
    const closed = once(child, "close")
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        const force = setTimeout(() => child.kill("SIGKILL"), 1000)
        try {
          await closed
        } finally {
          clearTimeout(force)
        }
      }
      rmSync(root, { recursive: true, force: true })
    })
    for (let attempt = 0; attempt < 200 && !existsSync(workerPidFile); attempt++) await delay(25)
    assert.ok(existsSync(workerPidFile), "test worker did not start")
    const workerPid = Number(readFileSync(workerPidFile, "utf8"))
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
    try {
      child.kill("SIGTERM")
      assert.deepEqual(await closed, [null, "SIGTERM"])
      let workerAlive = true
      for (let attempt = 0; attempt < 100 && workerAlive; attempt++) {
        try {
          process.kill(workerPid, 0)
        } catch (error) {
          if (error.code !== "ESRCH") throw error
          workerAlive = false
        }
        if (workerAlive) await delay(25)
      }
      assert.equal(workerAlive, false, "test worker survived wrapper termination")
    } finally {
      clearTimeout(timeout)
    }
  }
)
