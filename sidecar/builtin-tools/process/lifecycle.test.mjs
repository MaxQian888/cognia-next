import { test } from "node:test"
import assert from "node:assert/strict"

import { execStartProcess, execTerminateProcess } from "./lifecycle.mjs"
import { trackedPids } from "./inventory.mjs"

test("terminate_process refuses untracked pids by default", async () => {
  trackedPids.clear()
  const r = await execTerminateProcess({
    pid: 0x7fffffff,
    force: false,
    allowUntracked: false,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not started by this session/)
})

test("terminate_process surfaces a kill error with allowUntracked=true", async () => {
  const r = await execTerminateProcess({
    pid: 0x7fffffff,
    force: false,
    allowUntracked: true,
  })
  assert.equal(r.isError, true)
})

test("start_process surfaces a non-zero exit as a result (not a tool error)", async () => {
  // `git` is allowlisted and present; a bogus flag exits non-zero on every OS.
  const r = await execStartProcess({
    program: "git",
    args: ["--no-such-flag"],
    detached: false,
    timeoutSecs: 30,
  })
  assert.notEqual(r.isError, true) // a non-zero exit is a normal outcome
  const payload = JSON.parse(r.content[0].text)
  assert.notEqual(payload.exitCode, 0) // the REAL exit code, not hard-coded 0
  assert.ok(payload.stderr.length > 0) // captured output is preserved
})

test("start_process rejects a program not on the allowlist", async () => {
  const r = await execStartProcess({ program: "definitely-not-allowed", args: [], detached: true })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /allowlist/)
})

// ---- supervisor-bound behaviour -------------------------------------------

/** Minimal stand-in for the host-backed background-job registry. */
function fakeSupervisor(overrides = {}) {
  const calls = []
  return {
    calls,
    bgShells: {
      async spawnBackground(req) {
        calls.push({ method: "spawnBackground", req })
        return { id: "job-7", pid: 4242 }
      },
      async killByPid(pid) {
        calls.push({ method: "killByPid", pid })
        return { matched: true, ok: true, jobId: "job-7" }
      },
      ...overrides,
    },
  }
}

test("a detached start becomes a supervised job instead of an orphan daemon", async () => {
  // The old path was spawn({detached:true, stdio:"ignore"}) + unref(): no
  // output captured, nothing tracking it, and it outlived the app.
  const { bgShells, calls } = fakeSupervisor()
  const r = await execStartProcess(
    { program: "git", args: ["status"], detached: true, cwd: "/repo" },
    { bgShells }
  )

  assert.notEqual(r.isError, true)
  const payload = JSON.parse(r.content[0].text)
  assert.equal(payload.jobId, "job-7")
  assert.equal(payload.pid, 4242)
  assert.match(payload.note, /bash_output/, "the model is told where the output went")

  assert.equal(calls[0].method, "spawnBackground")
  assert.equal(calls[0].req.shell, "git")
  assert.deepEqual(calls[0].req.shellArgs, ["status"])
  assert.equal(calls[0].req.cwd, "/repo")
  assert.notEqual(
    calls[0].req.detach,
    true,
    "`detached` means return-immediately, NOT outlive-the-session"
  )
})

test("the allowlist still gates a supervised detached start", async () => {
  const { bgShells, calls } = fakeSupervisor()
  const r = await execStartProcess(
    { program: "definitely-not-allowed", args: [], detached: true },
    { bgShells }
  )
  assert.equal(r.isError, true)
  assert.equal(calls.length, 0, "rejected before reaching the supervisor")
})

test("a non-detached start is unaffected by the supervisor", async () => {
  const { bgShells, calls } = fakeSupervisor()
  const r = await execStartProcess(
    { program: "git", args: ["--no-such-flag"], detached: false, timeoutSecs: 30 },
    { bgShells }
  )
  assert.notEqual(r.isError, true)
  assert.equal(calls.length, 0, "capture-to-completion never goes through the supervisor")
})

test("terminate_process kills a supervised job by process group", async () => {
  const { bgShells, calls } = fakeSupervisor()
  const r = await execTerminateProcess({ pid: 4242, force: false }, { bgShells })

  assert.notEqual(r.isError, true)
  const payload = JSON.parse(r.content[0].text)
  assert.equal(payload.jobId, "job-7")
  assert.equal(payload.processGroup, true)
  assert.equal(calls[0].method, "killByPid")
})

test("terminate_process falls back to a raw signal for an unmatched pid", async () => {
  // "not one of our jobs" must not become "refuse to act".
  const { bgShells } = fakeSupervisor({ killByPid: async () => ({ matched: false }) })
  trackedPids.clear()
  const r = await execTerminateProcess(
    { pid: 0x7fffffff, force: false, allowUntracked: false },
    { bgShells }
  )
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not started by this session/)
})

test("terminate_process reports a supervisor rejection rather than silently signalling", async () => {
  const { bgShells } = fakeSupervisor({
    killByPid: async () => ({ matched: true, ok: false, reason: "owned by another session" }),
  })
  const r = await execTerminateProcess({ pid: 4242, force: false }, { bgShells })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /owned by another session/)
})
