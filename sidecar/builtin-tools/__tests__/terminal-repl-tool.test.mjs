// Tests for terminal-repl-tool.mjs — interactive node-pty REPL surface.
//
// We don't rely on node-pty actually being installed (it's
// optionalDependencies for exactly this reason). The test harness
// injects a fake `mod.spawn` via __setNodePtyForTesting so the action
// logic is covered cross-platform without a native build.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
  terminalReplTools,
  __testExports,
  __setNodePtyForTesting,
  createBunPtyModule,
  isBunPtyRuntime,
} from "../terminal-repl-tool.mjs"

const {
  execSpawn,
  execWrite,
  execRead,
  execKill,
  reset,
  sessions,
  reapIdleSessions,
  IDLE_TIMEOUT_MS,
} = __testExports

/** Build a minimal node-pty-shaped mock that the tool can drive. */
function makeFakePty({ failSpawn = false } = {}) {
  const ptys = []
  const mod = {
    spawn: (shell, args, opts) => {
      if (failSpawn) throw new Error("spawn refused by host")
      const ptyHandle = {
        shell,
        args,
        opts,
        writeBuffer: [],
        killed: false,
        signal: null,
        dataListener: null,
        exitListener: null,
        write(s) {
          this.writeBuffer.push(s)
        },
        kill(signal) {
          this.killed = true
          this.signal = signal ?? null
          // Simulate exit firing on kill — what real node-pty does.
          this.exitListener?.({ exitCode: 137, signal: signal ?? "SIGTERM" })
        },
        onData(cb) {
          this.dataListener = cb
        },
        onExit(cb) {
          this.exitListener = cb
        },
        // Test helper: simulate PTY emitting output.
        emitData(data) {
          this.dataListener?.(data)
        },
      }
      ptys.push(ptyHandle)
      return ptyHandle
    },
    __ptys: ptys,
  }
  return mod
}

let tmpdir
test.before(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "term-repl-"))
})
test.after(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true })
})
test.beforeEach(() => {
  reset()
  __setNodePtyForTesting(makeFakePty())
})

// ── spawn ─────────────────────────────────────────────────────────────

test("Bun.Terminal is adapted to the existing node-pty-shaped session seam", async () => {
  let captured
  let resolveExit
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  const terminal = {
    write: () => {},
    resize: () => {},
    close: () => {},
  }
  const runtime = {
    Terminal: class {},
    spawn(command, options) {
      captured = { command, options }
      return { terminal, exited, kill: () => {} }
    },
  }
  const pty = createBunPtyModule(runtime).spawn("/bin/bash", ["-i"], {
    name: "xterm-color",
    cols: 90,
    rows: 30,
    cwd: tmpdir,
    env: { TERM: "xterm" },
  })
  let output = ""
  let exitCode = null
  pty.onData((data) => {
    output += data
  })
  pty.onExit((event) => {
    exitCode = event.exitCode
  })
  captured.options.terminal.data(terminal, Buffer.from("ready\n"))
  resolveExit(7)
  await exited
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(captured.command, ["/bin/bash", "-i"])
  assert.equal(captured.options.cwd, tmpdir)
  assert.equal(captured.options.terminal.cols, 90)
  assert.equal(captured.options.terminal.rows, 30)
  assert.equal(output, "ready\n")
  assert.equal(exitCode, 7)
})

test("Bun PTY selection requires both callable terminal and spawn capabilities", () => {
  assert.equal(isBunPtyRuntime(undefined), false)
  assert.equal(isBunPtyRuntime({ Terminal: class {} }), false)
  assert.equal(isBunPtyRuntime({ Terminal: {}, spawn() {} }), false)
  assert.equal(isBunPtyRuntime({ Terminal: class {}, spawn() {} }), true)
})

test("execSpawn returns a sessionId for a happy-path spawn", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const result = await execSpawn({
    agentId: "agent-1",
    shell: "/bin/bash",
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  const body = JSON.parse(result.content[0].text)
  assert.equal(typeof body.sessionId, "string")
  assert.equal(body.shell, "/bin/bash")
  assert.equal(fake.__ptys.length, 1)
  assert.equal(fake.__ptys[0].opts.cwd, tmpdir)
})

test("execSpawn fails when cwd does not exist", async () => {
  const result = await execSpawn({
    agentId: "a",
    shell: "/bin/bash",
    cwd: path.join(tmpdir, "nowhere-here"),
    cols: 80,
    rows: 24,
  })
  assert.equal(result.isError, true)
})

test("execSpawn surfaces a clean error when node-pty is unavailable", async () => {
  __setNodePtyForTesting(null, "Cannot find module 'node-pty'")
  const result = await execSpawn({
    agentId: "a",
    shell: "/bin/bash",
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /node-pty/)
})

test("execSpawn surfaces node-pty.spawn() throws as a tool error", async () => {
  __setNodePtyForTesting(makeFakePty({ failSpawn: true }))
  const result = await execSpawn({
    agentId: "a",
    shell: "/bin/bash",
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /spawn refused/)
})

test("execSpawn enforces the per-agent session cap", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  for (let i = 0; i < __testExports.MAX_SESSIONS_PER_AGENT; i++) {
    const ok = await execSpawn({
      agentId: "busy-agent",
      shell: "/bin/bash",
      cwd: tmpdir,
      cols: 80,
      rows: 24,
    })
    assert.equal(ok.isError, undefined)
  }
  const overflow = await execSpawn({
    agentId: "busy-agent",
    shell: "/bin/bash",
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  assert.equal(overflow.isError, true)
})

// ── write ─────────────────────────────────────────────────────────────

test("execWrite forwards bytes to the PTY", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const spawnResult = await execSpawn({
    agentId: "a",
    shell: "/bin/bash",
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  const { sessionId } = JSON.parse(spawnResult.content[0].text)
  await execWrite({ agentId: "a", sessionId, data: "echo hi\n" })
  assert.deepEqual(fake.__ptys[0].writeBuffer, ["echo hi\n"])
})

test("execWrite rejects writes from a non-owner agent", async () => {
  __setNodePtyForTesting(makeFakePty())
  const spawnResult = await execSpawn({
    agentId: "owner",
    shell: "/bin/bash",
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  const { sessionId } = JSON.parse(spawnResult.content[0].text)
  const result = await execWrite({ agentId: "thief", sessionId, data: "ls\n" })
  assert.equal(result.isError, true)
})

test("execWrite refuses to write to an exited session", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  fake.__ptys[0].exitListener?.({ exitCode: 0, signal: null })
  const result = await execWrite({ agentId: "a", sessionId, data: "x\n" })
  assert.equal(result.isError, true)
})

// ── read ──────────────────────────────────────────────────────────────

test("execRead returns accumulated output and drains by default", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  fake.__ptys[0].emitData("hello world\n")
  fake.__ptys[0].emitData("more output\n")
  const first = JSON.parse(
    (await execRead({ agentId: "a", sessionId, drain: true })).content[0].text
  )
  assert.equal(first.data, "hello world\nmore output\n")
  const second = JSON.parse(
    (await execRead({ agentId: "a", sessionId, drain: true })).content[0].text
  )
  assert.equal(second.data, "")
})

test("execRead with drain=false leaves the buffer intact", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  fake.__ptys[0].emitData("peek\n")
  const a = JSON.parse((await execRead({ agentId: "a", sessionId, drain: false })).content[0].text)
  const b = JSON.parse((await execRead({ agentId: "a", sessionId, drain: false })).content[0].text)
  assert.equal(a.data, "peek\n")
  assert.equal(b.data, "peek\n")
})

test("execRead reports the exit state once the PTY has exited", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  fake.__ptys[0].exitListener?.({ exitCode: 42, signal: null })
  const result = JSON.parse(
    (await execRead({ agentId: "a", sessionId, drain: true })).content[0].text
  )
  assert.equal(result.exited, true)
  assert.equal(result.exitCode, 42)
})

test("output ring marks truncated=true when overflowing", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  const big = Buffer.alloc(__testExports.OUTPUT_RING_BYTES + 1024, 0x61) // 'a'
  fake.__ptys[0].emitData(big)
  const result = JSON.parse(
    (await execRead({ agentId: "a", sessionId, drain: true })).content[0].text
  )
  assert.equal(result.truncated, true)
  // The slice should be exactly OUTPUT_RING_BYTES wide.
  assert.equal(Buffer.byteLength(result.data, "utf8"), __testExports.OUTPUT_RING_BYTES)
})

// ── kill ──────────────────────────────────────────────────────────────

test("execKill is idempotent and reports exitCode", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  const first = JSON.parse((await execKill({ agentId: "a", sessionId })).content[0].text)
  assert.equal(first.ok, true)
  assert.equal(fake.__ptys[0].killed, true)
  const second = JSON.parse((await execKill({ agentId: "a", sessionId })).content[0].text)
  assert.equal(second.ok, true)
})

// ── idle GC ───────────────────────────────────────────────────────────

test("reapIdleSessions kills sessions past the idle window", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = JSON.parse(
    (await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 }))
      .content[0].text
  )
  const session = sessions.get(sessionId)
  session.lastActivityAt = Date.now() - IDLE_TIMEOUT_MS - 1000
  reapIdleSessions()
  assert.equal(fake.__ptys[0].killed, true)
  assert.equal(session.exited, true)
})

// ── exports ───────────────────────────────────────────────────────────

test("terminalReplTools exports exactly 4 tool descriptors", () => {
  assert.equal(terminalReplTools.length, 4)
  // The SDK's `tool(name, ...)` wraps each into an opaque descriptor —
  // we don't introspect its shape here, just confirm we registered 4.
})
