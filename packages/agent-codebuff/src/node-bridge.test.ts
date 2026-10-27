/** @jest-environment node */
import { build, stop } from "esbuild"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"
import type { BridgeFrame } from "./bridge-protocol"

// The SDK fixture drives the actual native IO overrides supplied by the production
// entry. It deliberately has no provider, network client, or Cognia client mock.
const sdkFixture = String.raw`
const childProcess = require("node:child_process")
exports.getBundledRgPath = () => process.env.FIXTURE_RG_PATH
exports.CodebuffClient = class {
  constructor(options) { this.options = options }
  async run({ prompt, signal }) {
    const input = JSON.parse(prompt), options = this.options
    const attempt = async (operation) => {
      try { await operation(); return { ok: true } }
      catch (error) { return { ok: false, error: error.message } }
    }
    if (input.kind === "files") {
      const results = []
      for (const item of input.operations) {
        results.push(await attempt(() => options.fsSource[item.method](...item.args)))
      }
      return results
    }
    if (input.kind === "tools") {
      return [
        await attempt(() => options.overrideTools.run_terminal_command({ command: input.command, cwd: input.cwd })),
        await attempt(() => options.overrideTools.code_search({ pattern: "fixture", flags: "-i", cwd: input.cwd })),
      ]
    }
    if (input.kind === "native") {
      const args = ["-e", "require('node:fs').writeFileSync(process.argv[1], 'executed')", input.marker]
      return [
        await attempt(() => childProcess.execFileSync(process.execPath, args)),
        await attempt(() => options.spawnSource(process.execPath, args)),
      ]
    }
    if (input.kind === "waiting") {
      const timer = setInterval(() => {}, 1000)
      const abort = () => {
        clearInterval(timer)
        options.handleEvent({ type: "fixture-aborted" })
      }
      signal.addEventListener("abort", abort, { once: true })
      options.handleEvent({ type: "fixture-waiting" })
      try {
        if (input.network) {
          await fetch("https://fixture.invalid/model", { method: "POST", body: "fixture", signal })
        } else {
          await options.fsSource.writeFile(input.target, "must not be written")
        }
      } finally {
        clearInterval(timer)
        signal.removeEventListener("abort", abort)
      }
      return { done: true }
    }
    throw new Error("Unknown fixture operation")
  }
}
`

class BridgeProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly frames: BridgeFrame[] = []
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stderr = ""
  private waiters = new Set<() => void>()
  private turn = 0
  private closeResult?: { code: number | null; signal: NodeJS.Signals | null }

  constructor(bundle: string, cwd: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [bundle, "--cognia-codebuff-bridge"], {
      cwd,
      env: { ...process.env, ...env, CODEBUFF_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stderr.on("data", (data: Buffer) => {
      this.stderr += data.toString()
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      this.frames.push(JSON.parse(line) as BridgeFrame)
      for (const waiter of this.waiters) waiter()
    })
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.closeResult = { code, signal }
        lines.close()
        resolve(this.closeResult)
        for (const waiter of this.waiters) waiter()
      })
    })
  }

  send(frame: BridgeFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(frame) + "\n", (error) =>
        error ? reject(error) : resolve()
      )
    })
  }

  waitFor(predicate: (frame: BridgeFrame) => boolean): Promise<BridgeFrame> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        this.waiters.delete(check)
      }
      const check = () => {
        const found = this.frames.find(predicate)
        if (found) {
          cleanup()
          resolve(found)
        } else if (this.closeResult) {
          cleanup()
          reject(new Error(`Bridge exited before its frame: ${this.stderr}`))
        }
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Bridge frame timed out: ${this.stderr}`))
      }, 4000)
      this.waiters.add(check)
      check()
    })
  }

  async run(input: Record<string, unknown>): Promise<string> {
    const turnId = `fixture-${++this.turn}`
    await this.send({
      type: "run",
      turnId,
      agent: "codebuff/base@0.0.16",
      prompt: JSON.stringify(input),
    })
    return turnId
  }

  result(turnId: string): Promise<BridgeFrame> {
    return this.waitFor((frame) => frame.type === "result" && frame.turnId === turnId)
  }

  async stop(): Promise<void> {
    if (this.closeResult) return
    this.child.kill("SIGKILL")
    await this.closed
  }
}

describe("Codebuff production Node entry over real JSONL IPC", () => {
  let scratch: string, bundle: string, workspace: string, bridge: BridgeProcess

  beforeAll(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codebuff-entry-")))
    bundle = path.join(scratch, "bridge.cjs")
    await build({
      entryPoints: [path.join(__dirname, "node-bridge.ts")],
      outfile: bundle,
      platform: "node",
      format: "cjs",
      target: "node26",
      bundle: true,
      external: ["@codebuff/sdk"],
      logLevel: "silent",
    })
    const sdk = path.join(scratch, "node_modules", "@codebuff", "sdk")
    await fs.mkdir(sdk, { recursive: true })
    await fs.writeFile(path.join(sdk, "package.json"), JSON.stringify({ main: "index.cjs" }))
    await fs.writeFile(path.join(sdk, "index.cjs"), sdkFixture)
  })

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(scratch, "workspace-"))
  })

  afterEach(async () => {
    await bridge?.stop()
  })

  afterAll(async () => {
    await stop()
    await fs.rm(scratch, { recursive: true, force: true })
  })

  async function start(env?: Record<string, string>) {
    bridge = new BridgeProcess(bundle, workspace, env)
    await bridge.send({ type: "init", cwd: workspace })
    await bridge.waitFor((frame) => frame.type === "ready")
  }

  const posixTest = process.platform === "win32" ? it.skip : it
  posixTest(
    "rejects outside paths and escaping symlinks before any filesystem approval",
    async () => {
      const outside = await fs.mkdtemp(path.join(scratch, "outside-"))
      const secret = path.join(outside, "secret.txt")
      await fs.writeFile(secret, "private fixture")
      const link = path.join(workspace, "escape")
      await fs.symlink(outside, link, "dir")
      await start()
      const operations = [outside, link].flatMap((directory) => [
        { method: "readdir", args: [directory] },
        { method: "stat", args: [path.join(directory, "secret.txt")] },
        { method: "readFile", args: [path.join(directory, "secret.txt"), "utf8"] },
        { method: "unlink", args: [path.join(directory, "secret.txt")] },
        { method: "writeFile", args: [path.join(directory, "new.txt"), "escaped"] },
        { method: "mkdir", args: [path.join(directory, "new-dir")] },
      ])
      const result = await bridge.result(await bridge.run({ kind: "files", operations }))
      expect(result.state).toEqual(
        operations.map((_, index) => ({
          ok: false,
          error:
            index < 6
              ? "Codebuff file is outside the workspace"
              : "Codebuff symlink escapes its workspace",
        }))
      )
      expect(bridge.frames.filter((frame) => frame.type === "host-request")).toEqual([])
      expect(await fs.readFile(secret, "utf8")).toBe("private fixture")
      expect(await fs.readdir(outside)).toEqual(["secret.txt"])
    }
  )

  it("waits for approval before a write, leaves a denied target absent, and performs an approved write", async () => {
    await start()
    const target = path.join(workspace, "approved.txt")
    const input = {
      kind: "files",
      operations: [{ method: "writeFile", args: [target, "approved content"] }],
    }
    const deniedTurn = await bridge.run(input)
    const denied = await bridge.waitFor(
      (frame) => frame.type === "host-request" && frame.name === "write_file"
    )
    expect(denied).toMatchObject({ kind: "approval", input: { path: target } })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
    expect(bridge.frames.some((frame) => frame.type === "result")).toBe(false)
    await bridge.send({ type: "host-result", requestId: denied.requestId, result: false })
    expect((await bridge.result(deniedTurn)).state).toEqual([
      { ok: false, error: "Codebuff tool denied by host policy" },
    ])
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })

    const approvedTurn = await bridge.run(input)
    const approved = await bridge.waitFor(
      (frame) => frame.type === "host-request" && frame.requestId !== denied.requestId
    )
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
    await bridge.send({ type: "host-result", requestId: approved.requestId, result: true })
    expect((await bridge.result(approvedTurn)).state).toEqual([{ ok: true }])
    expect(await fs.readFile(target, "utf8")).toBe("approved content")
  })

  posixTest("rechecks symlink confinement after the host approves a pending write", async () => {
    const outside = await fs.mkdtemp(path.join(scratch, "swap-outside-"))
    const directory = path.join(workspace, "pending")
    const target = path.join(directory, "file.txt")
    await fs.mkdir(directory)
    await start()
    const turnId = await bridge.run({
      kind: "files",
      operations: [{ method: "writeFile", args: [target, "escaped after approval"] }],
    })
    const approval = await bridge.waitFor((frame) => frame.type === "host-request")
    await fs.rmdir(directory)
    await fs.symlink(outside, directory, "dir")
    await bridge.send({ type: "host-result", requestId: approval.requestId, result: true })
    expect((await bridge.result(turnId)).state).toEqual([
      { ok: false, error: "Codebuff symlink escapes its workspace" },
    ])
    expect(await fs.readdir(outside)).toEqual([])
  })

  it("denies shell and search before native execution and installs the SDK subprocess guard", async () => {
    const shellMarker = path.join(workspace, "shell-executed")
    const searchMarker = path.join(workspace, "search-executed")
    const rg = path.join(workspace, "fixture-rg")
    await fs.writeFile(
      rg,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(searchMarker)}, 'executed')\n`,
      { mode: 0o700 }
    )
    await start({ FIXTURE_RG_PATH: rg })
    const turnId = await bridge.run({
      kind: "tools",
      cwd: workspace,
      command: `printf executed > ${JSON.stringify(shellMarker)}`,
    })
    const shell = await bridge.waitFor(
      (frame) => frame.type === "host-request" && frame.name === "run_terminal_command"
    )
    await bridge.send({ type: "host-result", requestId: shell.requestId, result: false })
    const search = await bridge.waitFor(
      (frame) => frame.type === "host-request" && frame.name === "read_files"
    )
    expect(search).toMatchObject({ input: { operation: "code_search", pattern: "fixture" } })
    await bridge.send({ type: "host-result", requestId: search.requestId, result: false })
    expect((await bridge.result(turnId)).state).toEqual([
      { ok: false, error: "Codebuff tool denied by host policy" },
      { ok: false, error: "Codebuff tool denied by host policy" },
    ])
    const nativeMarker = path.join(workspace, "native-executed")
    expect(
      (await bridge.result(await bridge.run({ kind: "native", marker: nativeMarker }))).state
    ).toEqual([
      { ok: false, error: "Unbrokered Codebuff subprocess is forbidden" },
      { ok: false, error: "Unsupported unbrokered Codebuff subprocess" },
    ])
    for (const marker of [shellMarker, searchMarker, nativeMarker])
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("cancels a pending approval, aborts SDK work, and rejects a late approval without writing", async () => {
    await start()
    const target = path.join(workspace, "cancelled.txt")
    const turnId = await bridge.run({ kind: "waiting", target })
    const approval = await bridge.waitFor((frame) => frame.type === "host-request")
    await bridge.send({ type: "cancel", turnId })
    await bridge.waitFor(
      (frame) =>
        frame.type === "event" && (frame.event as { type?: string }).type === "fixture-aborted"
    )
    expect(
      await bridge.waitFor((frame) => frame.type === "error" && frame.turnId === turnId)
    ).toMatchObject({
      error: "Codebuff run cancelled",
    })
    await bridge.send({ type: "host-result", requestId: approval.requestId, result: true })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      (await bridge.result(await bridge.run({ kind: "files", operations: [] }))).state
    ).toEqual([])
  })

  it("aborts pending network work and exits cleanly on stdin EOF", async () => {
    await start()
    const turnId = await bridge.run({ kind: "waiting", network: true })
    const request = await bridge.waitFor(
      (frame) => frame.type === "host-request" && frame.kind === "network"
    )
    bridge.child.stdin.end()
    await bridge.waitFor(
      (frame) => frame.type === "network-cancel" && frame.requestId === request.requestId
    )
    expect(await bridge.closed).toEqual({ code: 0, signal: null })
    expect(bridge.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "event", event: { type: "fixture-aborted" } }),
        expect.objectContaining({ type: "error", turnId, error: "Codebuff run cancelled" }),
      ])
    )
    expect(bridge.stderr).toBe("")
  })
})
