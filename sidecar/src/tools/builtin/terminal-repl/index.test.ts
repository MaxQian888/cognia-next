// Tests for the terminal-repl tools — interactive node-pty REPL surface.
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
  createTerminalReplTools,
  disposeTerminalRepls,
  __testExports,
  __setNodePtyForTesting,
  createBunPtyModule,
  isBunPtyRuntime,
  prepareNodePtyHelper,
} from "./index.ts"
import type { BunPtyRuntime, PtyExit, PtyModule, PtySpawnOptions } from "./index.ts"
import { firstText, firstJson } from "../../../../test-support/tool-result.ts"

const {
  execSpawn,
  execWrite,
  execRead,
  execKill,
  reset,
  sessions,
  reapIdleSessions,
  IDLE_TIMEOUT_MS,
  OUTPUT_RING_BYTES,
} = __testExports

/** Every field the REPL tools answer with; each test reads its own. */
interface ReplOutput {
  sessionId: string
  shell: string
  data: string
  truncated: boolean
  exited: boolean
  exitCode: number | null
  ok?: boolean
}

/** A fake PTY handle, with the test's recording fields. */
interface FakePtyHandle {
  shell: string
  args: string[]
  opts: PtySpawnOptions
  writeBuffer: string[]
  killed: boolean
  signal: string | null
  dataListener: ((data: string | Buffer) => void) | null
  exitListener: ((exit: PtyExit) => void) | null
  write(s: string): void
  kill(signal?: string): void
  onData(cb: (data: string | Buffer) => void): void
  onExit(cb: (exit: PtyExit) => void): void
  emitData(data: string | Buffer): void
}

type FakePtyModule = PtyModule & { __ptys: FakePtyHandle[] }

/** Build a minimal node-pty-shaped mock that the tool can drive. */
function makeFakePty({ failSpawn = false }: { failSpawn?: boolean } = {}): FakePtyModule {
  const ptys: FakePtyHandle[] = []
  const mod: FakePtyModule = {
    spawn: (shell, args, opts) => {
      if (failSpawn) throw new Error("spawn refused by host")
      const ptyHandle: FakePtyHandle = {
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

let tmpdir: string
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
  let captured: { command: string[]; options: Parameters<BunPtyRuntime["spawn"]>[1] } | undefined
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve
  })
  const terminal = {
    write: () => {},
    resize: () => {},
    close: () => {},
  }
  const runtime: BunPtyRuntime = {
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
  let exitCode: number | null = null
  pty.onData((data) => {
    output += String(data)
  })
  pty.onExit?.((event) => {
    exitCode = event.exitCode
  })
  assert.ok(captured)
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
  const body = firstJson<ReplOutput>(result)
  assert.equal(typeof body.sessionId, "string")
  assert.equal(body.shell, "/bin/bash")
  assert.equal(fake.__ptys.length, 1)
  assert.equal(fake.__ptys[0]!.opts.cwd, tmpdir)
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
  assert.match(firstText(result), /node-pty/)
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
  assert.match(firstText(result), /spawn refused/)
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
  const { sessionId } = firstJson<ReplOutput>(spawnResult)
  await execWrite({ agentId: "a", sessionId, data: "echo hi\n" })
  assert.deepEqual(fake.__ptys[0]!.writeBuffer, ["echo hi\n"])
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
  const { sessionId } = firstJson<ReplOutput>(spawnResult)
  const result = await execWrite({ agentId: "thief", sessionId, data: "ls\n" })
  assert.equal(result.isError, true)
})

test("execWrite refuses to write to an exited session", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  fake.__ptys[0]!.exitListener?.({ exitCode: 0, signal: null })
  const result = await execWrite({ agentId: "a", sessionId, data: "x\n" })
  assert.equal(result.isError, true)
})

// ── read ──────────────────────────────────────────────────────────────

test("execRead returns accumulated output and drains by default", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  fake.__ptys[0]!.emitData("hello world\n")
  fake.__ptys[0]!.emitData("more output\n")
  const first = firstJson<ReplOutput>(
    await execRead({ maxBytes: OUTPUT_RING_BYTES, agentId: "a", sessionId, drain: true })
  )
  assert.equal(first.data, "hello world\nmore output\n")
  const second = firstJson<ReplOutput>(
    await execRead({ maxBytes: OUTPUT_RING_BYTES, agentId: "a", sessionId, drain: true })
  )
  assert.equal(second.data, "")
})

test("execRead with drain=false leaves the buffer intact", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  fake.__ptys[0]!.emitData("peek\n")
  const a = firstJson<ReplOutput>(
    await execRead({ maxBytes: OUTPUT_RING_BYTES, agentId: "a", sessionId, drain: false })
  )
  const b = firstJson<ReplOutput>(
    await execRead({ maxBytes: OUTPUT_RING_BYTES, agentId: "a", sessionId, drain: false })
  )
  assert.equal(a.data, "peek\n")
  assert.equal(b.data, "peek\n")
})

test("execRead reports the exit state once the PTY has exited", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  fake.__ptys[0]!.exitListener?.({ exitCode: 42, signal: null })
  const result = firstJson<ReplOutput>(
    await execRead({ maxBytes: OUTPUT_RING_BYTES, agentId: "a", sessionId, drain: true })
  )
  assert.equal(result.exited, true)
  assert.equal(result.exitCode, 42)
})

test("output ring marks truncated=true when overflowing", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  const big = Buffer.alloc(__testExports.OUTPUT_RING_BYTES + 1024, 0x61) // 'a'
  fake.__ptys[0]!.emitData(big)
  const result = firstJson<ReplOutput>(
    await execRead({ maxBytes: OUTPUT_RING_BYTES, agentId: "a", sessionId, drain: true })
  )
  assert.equal(result.truncated, true)
  // The slice should be exactly OUTPUT_RING_BYTES wide.
  assert.equal(Buffer.byteLength(result.data, "utf8"), __testExports.OUTPUT_RING_BYTES)
})

// ── kill ──────────────────────────────────────────────────────────────

test("execKill is idempotent and reports exitCode", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  const first = firstJson<ReplOutput>(await execKill({ agentId: "a", sessionId }))
  assert.equal(first.ok, true)
  assert.equal(fake.__ptys[0]!.killed, true)
  const second = firstJson<ReplOutput>(await execKill({ agentId: "a", sessionId }))
  assert.equal(second.ok, true)
})

// ── idle GC ───────────────────────────────────────────────────────────

test("reapIdleSessions kills sessions past the idle window", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const { sessionId } = firstJson<ReplOutput>(
    await execSpawn({ agentId: "a", shell: "/bin/bash", cwd: tmpdir, cols: 80, rows: 24 })
  )
  const session = sessions.get(sessionId)
  assert.ok(session)
  session.lastActivityAt = Date.now() - IDLE_TIMEOUT_MS - 1000
  reapIdleSessions()
  assert.equal(fake.__ptys[0]!.killed, true)
  assert.equal(session.exited, true)
})

// ── exports ───────────────────────────────────────────────────────────

test("terminalReplTools exports exactly 4 tool descriptors", () => {
  assert.equal(terminalReplTools.length, 4)
  // The SDK's `tool(name, ...)` wraps each into an opaque descriptor —
  // we don't introspect its shape here, just confirm we registered 4.
})

test("session-bound PTYs use sandbox argv, prevent forged ownership, and dispose on close", async () => {
  const fake = makeFakePty()
  __setNodePtyForTesting(fake)
  const tools = createTerminalReplTools({
    sessionId: "owner1",
    builtinProcessSandbox: {
      launcher: process.execPath,
      writableRoots: [tmpdir],
      readableRoots: [],
      network: false,
    },
  })
  const result = await tools[0]!.handler({
    agentId: "forged",
    shell: "/bin/sh",
    args: ["-i"],
    cwd: tmpdir,
    cols: 80,
    rows: 24,
  })
  const { sessionId } = firstJson<ReplOutput>(result)
  assert.equal(fake.__ptys[0]!.shell, process.execPath)
  assert.deepEqual(fake.__ptys[0]!.args.slice(-3), ["--", "/bin/sh", "-i"])
  assert.equal(sessions.get(sessionId)!.agentId, "owner1")
  const other = createTerminalReplTools({ sessionId: "owner2" })
  const denied = await other[1]!.handler({ agentId: "owner1", sessionId, data: "echo unsafe\n" })
  assert.equal(denied.isError, true)
  disposeTerminalRepls("owner1")
  assert.equal(fake.__ptys[0]!.killed, true)
  assert.equal(sessions.has(sessionId), false)
})

// ── packaged node-pty helper ──────────────────────────────────────────

test("restores packaged PTY helper execute permission without changing other bits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-"))
  try {
    const directory = path.join(root, "prebuilds/darwin-arm64")
    fs.mkdirSync(directory, { recursive: true })
    const helper = path.join(directory, "spawn-helper")
    fs.writeFileSync(helper, "helper", { mode: 0o640 })
    prepareNodePtyHelper(root, "darwin", "arm64")
    assert.equal(fs.statSync(helper).mode & 0o777, 0o751)
    prepareNodePtyHelper(root, "darwin", "arm64")
    assert.equal(fs.statSync(helper).mode & 0o777, 0o751)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("missing optional helpers and Windows need no permission mutation", () => {
  assert.doesNotThrow(() => prepareNodePtyHelper("/nonexistent/node-pty", "darwin", "arm64"))
  assert.doesNotThrow(() => prepareNodePtyHelper("/nonexistent/node-pty", "win32", "x64"))
})

test("read-only installations expose a repair instruction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-readonly-"))
  try {
    const directory = path.join(root, "build/Release")
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, "spawn-helper"), "helper", { mode: 0o644 })
    t.mock.method(fs, "chmodSync", () => {
      throw new Error("EROFS")
    })
    assert.throws(
      () => prepareNodePtyHelper(root, "darwin", "arm64"),
      /PTY helper is not executable:.*Reinstall node-pty.*EROFS/
    )
  } finally {
    t.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
