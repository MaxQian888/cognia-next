import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fsp from "node:fs/promises"

import {
  createBashTool,
  createBashOutputTool,
  createKillShellTool,
  createListShellsTool,
  resolveShellInvocation,
  bashToolDescription,
  tailTruncate,
  composeBashBody,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "./bash.ts"
import { findDangerousShellFragment } from "../../../policy/shell/ast-scan.ts"
import { createBgShellRegistry } from "../../state/background-shells.ts"
import { resolveShellDescriptor, activeShellDescriptor } from "../../../platform/process/shell.ts"
import type { SessionBgShellRegistry } from "../../state/host-background-shells.ts"
import { asCallable } from "../../../../test-support/tool-result.ts"
import type { CallableTool } from "../../../../test-support/tool-result.ts"

// Pin a deterministic shell for command-executing tests: cmd.exe on Windows
// (lookup returns null → no PowerShell), /bin/sh elsewhere. This keeps the
// plumbing assertions (spill, workdir, background) independent of whatever shell
// the runner machine happens to have on PATH. Shell-selection itself is covered
// by src/platform/process/shell.test.ts.
const legacyShell = resolveShellDescriptor({ lookup: () => null })

function textOf(result: { content: unknown[] }): string {
  return result.content.map((b) => (b as { text?: string }).text).join("\n")
}

function extractShellId(text: string): string | null {
  const m = text.match(/background shell started: (\S+)/)
  return m ? m[1]! : null
}

async function pollUntil(
  outputTool: CallableTool,
  shellId: string | null,
  predicate: (text: string, all: string) => boolean,
  timeoutMs = 5000
) {
  const deadline = Date.now() + timeoutMs
  let acc = ""
  while (Date.now() < deadline) {
    const res = await outputTool.handler({ shellId }, {})
    acc += textOf(res)
    if (predicate(textOf(res), acc)) return acc
    await new Promise((r) => setTimeout(r, 25))
  }
  return acc
}

test("bash runs a command and returns its output", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "echo core-bash-ok" }, {})
  assert.ok(!res.isError, textOf(res))
  assert.match(textOf(res), /core-bash-ok/)
})

test("bash connects child stdin to a pipe instead of the null device", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(String(require('node:fs').fstatSync(0).isCharacterDevice()))"`
  const res = await tool.handler({ command }, {})
  assert.ok(!res.isError, textOf(res))
  assert.equal(textOf(res), "false")
})

test("bash surfaces non-zero exit codes as errors", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "exit 3" }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /exit code 3/)
})

test("bash kills on timeout and says so", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const sleepCmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const res = await tool.handler({ command: sleepCmd, timeout: 500 }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /timed out after 500 ms/)
})

test("bash hard-rejects destructive chaining patterns", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "echo hi && rm -rf /" }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /rejected/)
  assert.match(textOf(res), /&& rm/)
})

test("bash allows safe device sinks and quoted shell-looking text", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  // Linux cannot reopen Node socket-backed stderr through /dev/stderr.
  // Test that path at the policy seam; duplicate fd 2 for execution below.
  assert.equal(findDangerousShellFragment("printf safe > /dev/stderr"), null)
  for (const command of [
    "printf safe >/dev/null && printf ok",
    "printf safe 2>/dev/null",
    "printf safe &>/dev/null",
    "printf safe >&2",
    "printf '%s' '>/dev/sda'",
    'printf "%s" "&& rm -rf /"',
  ]) {
    const res = await tool.handler({ command }, {})
    assert.equal(res.isError, undefined, `${command}: ${textOf(res)}`)
  }
})

test("bash rejects actual writes to device nodes but not the same text in an argument", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "printf unsafe >/dev/sda" }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /device redirect/)
  assert.match(textOf(res), />\/dev\/sda/)
})

test("bash redirects an interactive command to a PTY and never spawns it", async () => {
  // The interactive guard returns before any spawn: assert the PTY-redirect
  // message (only the early guard can produce it) and that no spill file is
  // created — a structural proof that execution never reached `spawn`.
  const tmp = os.tmpdir()
  const countSpills = async () =>
    (await fsp.readdir(tmp)).filter((f) => f.startsWith("cognia-bash-")).length
  const before = await countSpills()
  const tool = asCallable(createBashTool({ cwd: tmp, shell: legacyShell }))
  for (const command of ["vim notes.txt", "python", "ssh example.com", "git rebase -i main"]) {
    const res = await tool.handler({ command }, {})
    assert.equal(res.isError, true, command)
    assert.match(textOf(res), /interactive and needs a TTY/, command)
    assert.match(textOf(res), /terminal_repl_spawn/, command)
  }
  assert.equal(await countSpills(), before, "interactive commands must never spawn (no spill)")
})

test("bash does NOT intercept an interactive command in background mode", async () => {
  // run_in_background is exempt from the interactive guard. With no background
  // registry the call falls through to the background branch (not the guard),
  // proving the guard was bypassed.
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "python", run_in_background: true }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /background execution is not available/)
  assert.doesNotMatch(textOf(res), /interactive and needs a TTY/)
})

test("bash still runs a normal command whose argument merely mentions an editor", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "echo vim" }, {})
  assert.ok(!res.isError, textOf(res))
  assert.match(textOf(res), /vim/)
})

test("bash respects workdir", async () => {
  const tool = asCallable(createBashTool({ cwd: os.homedir(), shell: legacyShell }))
  const printCwd = process.platform === "win32" ? "cd" : "pwd"
  const res = await tool.handler({ command: printCwd, workdir: os.tmpdir() }, {})
  const out = textOf(res).toLowerCase()
  // Compare path tails — Windows `cd` prints the resolved 8.3-free path.
  assert.ok(out.includes(os.tmpdir().split(/[\\/]/).pop()!.toLowerCase()))
})

test("tailTruncate keeps the tail and flags truncation", () => {
  const { text, truncated } = tailTruncate("a".repeat(100), 10)
  assert.equal(truncated, true)
  assert.match(text, /earlier characters dropped/)
  assert.ok(text.endsWith("a".repeat(10)))
  assert.deepEqual(tailTruncate("short", 10), { text: "short", truncated: false })
})

test("composeBashBody inlines small output and previews large spilled output", () => {
  // Small / no spill → inline.
  const small = composeBashBody({ head: "", tail: "hello", total: 5, fullPath: null })
  assert.deepEqual(small, { body: "hello", truncated: false })

  // Large + spilled → head/tail preview that names the file.
  const head = "H".repeat(12_000)
  const tail = "T".repeat(18_000)
  const big = composeBashBody({ head, tail, total: 50_000, fullPath: "/tmp/x.log" })
  assert.equal(big.truncated, true)
  assert.match(big.body, /full output saved to \/tmp\/x\.log/)
  assert.match(big.body, /characters omitted/)
  assert.ok(big.body.startsWith(head))
  assert.ok(big.body.endsWith(tail))
})

test("bash spills oversized output to a temp file and previews it", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  // Emit ~80k chars of output, well over MAX_OUTPUT_CHARS.
  const n = 80_000
  const cmd = `node -e "process.stdout.write('x'.repeat(${n}))"`
  const res = await tool.handler({ command: cmd }, {})
  assert.ok(!res.isError, textOf(res))
  const text = textOf(res)
  assert.match(text, /full output saved to .+cognia-bash-.+\.log/)
  // The named spill file exists and holds the complete output.
  const m = text.match(/full output saved to (\S+\.log)/)
  assert.ok(m, "expected a spill path")
  const full = await fsp.readFile(m[1]!, "utf-8")
  assert.equal(full.length, n)
  await fsp.unlink(m[1]!).catch(() => {})
})

test("bash inlines output under the limit without leaving a spill file", async () => {
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await tool.handler({ command: "echo small-inline" }, {})
  assert.ok(!res.isError, textOf(res))
  assert.match(textOf(res), /small-inline/)
  assert.doesNotMatch(textOf(res), /full output saved/)
})

test("bash never creates a temp spill file for small output", async () => {
  // Lazy-spill: under the inline budget no temp file should be created at all
  // (not created-then-unlinked). Snapshot the cognia-bash-* temp files before
  // and after; the count must not grow.
  const tmp = os.tmpdir()
  const countSpills = async () =>
    (await fsp.readdir(tmp)).filter((f) => f.startsWith("cognia-bash-")).length
  const before = await countSpills()
  const tool = asCallable(createBashTool({ cwd: tmp, shell: legacyShell }))
  for (let i = 0; i < 3; i++) {
    const res = await tool.handler({ command: "echo no-spill-please" }, {})
    assert.ok(!res.isError, textOf(res))
  }
  assert.equal(await countSpills(), before, "small runs must not create spill files")
})

test("timeout bounds are sane", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000)
  assert.equal(MAX_TIMEOUT_MS, 600_000)
})

// End-to-end proofs that PowerShell actually DRIVES execution on a PowerShell
// host (not just that argv is shaped right). Auto-skipped on hosts without
// PowerShell on PATH (Linux/macOS CI, bare Windows) so the suite stays hermetic.
const psHost = ["pwsh", "powershell"].includes(activeShellDescriptor().kind)

test(
  "bash executes native PowerShell syntax when the host shell is PowerShell",
  { skip: !psHost },
  async () => {
    const tool = asCallable(createBashTool({ cwd: os.tmpdir() })) // real host descriptor
    // `'ab' * 2` is PowerShell string repetition (→ abab); cmd.exe would error.
    const res = await tool.handler({ command: "Write-Output ('ab' * 2)" }, {})
    assert.ok(!res.isError, textOf(res))
    assert.match(textOf(res), /abab/)
  }
)

test("bash scrubs PSModulePath from the PowerShell child env", { skip: !psHost }, async () => {
  const prev = process.env.PSModulePath
  process.env.PSModulePath = "D:\\sentinel-evil-modules"
  try {
    const tool = asCallable(createBashTool({ cwd: os.tmpdir() }))
    const res = await tool.handler({ command: "Write-Output $env:PSModulePath" }, {})
    assert.ok(!res.isError, textOf(res))
    // The poisoned value must not survive into the child; PowerShell recomputes
    // its safe default path instead.
    assert.doesNotMatch(textOf(res), /sentinel-evil-modules/)
  } finally {
    if (prev === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = prev
  }
})

test("bashToolDescription embeds the PowerShell syntax hint", () => {
  const d = resolveShellDescriptor({
    platform: "win32",
    lookup: (n) => (n.startsWith("pwsh") ? n : null),
  })
  const desc = bashToolDescription(d)
  assert.match(desc, /\$env:VAR/)
  assert.match(desc, /run_in_background/)
})

test("bashToolDescription falls back to a 'Runs <label>' note for sh", () => {
  const d = resolveShellDescriptor({ platform: "linux" })
  const desc = bashToolDescription(d)
  assert.match(desc, /Runs POSIX sh/)
})

test("bashToolDescription steers interactive programs to terminal_repl_*", () => {
  const desc = bashToolDescription(resolveShellDescriptor({ platform: "linux" }))
  assert.match(desc, /Interactive programs.*terminal_repl/)
})

test("resolveShellInvocation returns a platform shell + argv", () => {
  const { shell, shellArgs, isWin } = resolveShellInvocation("echo hi")
  assert.equal(typeof shell, "string")
  assert.ok(shellArgs.includes("echo hi"))
  assert.equal(isWin, process.platform === "win32")
})

test("resolveShellInvocation honors an injected descriptor (pwsh argv + scrubbed env)", () => {
  const descriptor = {
    isWin: true,
    bin: "pwsh.exe",
    buildArgs: (cmd: string) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
    sanitizeEnv: <E extends Record<string, string | undefined>>(env: E): E => {
      const { PSModulePath: _drop, ...rest } = env
      return rest as E
    },
  }
  const inv = resolveShellInvocation("Get-ChildItem", descriptor)
  assert.equal(inv.shell, "pwsh.exe")
  assert.deepEqual(inv.shellArgs, ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"])
  // env is the scrubbed copy of process.env — PSModulePath removed if present.
  assert.ok(!("PSModulePath" in inv.env))
})

test("bash run_in_background returns a shellId and does not block", async () => {
  const bgShells = createBgShellRegistry()
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), bgShells, shell: legacyShell }))
  const longCmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const res = await bash.handler({ command: longCmd, run_in_background: true }, {})
  assert.ok(!res.isError, textOf(res))
  const id = extractShellId(textOf(res))
  assert.ok(id, "expected a shellId in the output")
  // Clean up the long-running shell.
  bgShells.killAll()
})

test("bash run_in_background errors without a registry", async () => {
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  const res = await bash.handler({ command: "echo hi", run_in_background: true }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /not available/)
})

test("bash_output follows a background shell to completion", async () => {
  const bgShells = createBgShellRegistry()
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), bgShells, shell: legacyShell }))
  const output = asCallable(createBashOutputTool({ bgShells }))
  const start = await bash.handler({ command: "echo follow-me", run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  const acc = await pollUntil(output, id, (_t, all) => /exited/.test(all))
  assert.match(acc, /follow-me/)
  assert.match(acc, /exited/)
})

test("bash_output can wait for output and cap each returned chunk", async () => {
  const bgShells = createBgShellRegistry()
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), bgShells, shell: legacyShell }))
  const output = asCallable(createBashOutputTool({ bgShells }))
  const command =
    process.platform === "win32"
      ? "ping -n 2 127.0.0.1 >nul && echo 1234567890"
      : "sleep 0.1; printf 1234567890"
  const start = await bash.handler({ command, run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  const first = await output.handler({ shellId: id, wait_ms: 2000, max_chars: 4 }, {})
  assert.match(textOf(first), /^1234/)
  const second = await output.handler({ shellId: id, max_chars: 20 }, {})
  assert.match(textOf(second), /^567890/)
})

test("list_shells inventories running and completed background commands", async () => {
  const bgShells = createBgShellRegistry()
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), bgShells, shell: legacyShell }))
  const list = asCallable(createListShellsTool({ bgShells }))
  const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const start = await bash.handler({ command, run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  const result = await list.handler({}, {})
  const payload = JSON.parse(textOf(result))
  assert.equal(payload.shells[0].id, id)
  assert.equal(payload.shells[0].status, "running")
  bgShells.killAll()
})

test("bash_output reports no-new-output and unknown ids", async () => {
  const bgShells = createBgShellRegistry()
  const output = asCallable(createBashOutputTool({ bgShells }))
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), bgShells, shell: legacyShell }))
  const start = await bash.handler({ command: "echo once", run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  await pollUntil(output, id, (_t, all) => /exited/.test(all))
  const again = await output.handler({ shellId: id }, {})
  assert.match(textOf(again), /no new output/)
  const missing = await output.handler({ shellId: "nope" }, {})
  assert.equal(missing.isError, true)
})

test("kill_shell terminates a background shell and is idempotent", async () => {
  const bgShells = createBgShellRegistry()
  const bash = asCallable(createBashTool({ cwd: os.tmpdir(), bgShells, shell: legacyShell }))
  const kill = asCallable(createKillShellTool({ bgShells }))
  const longCmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const start = await bash.handler({ command: longCmd, run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  const k1 = await kill.handler({ shellId: id }, {})
  assert.ok(!k1.isError, textOf(k1))
  assert.match(textOf(k1), /killed background shell/)
  const k2 = await kill.handler({ shellId: id }, {})
  assert.ok(!k2.isError)
  const missing = await kill.handler({ shellId: "nope" }, {})
  assert.equal(missing.isError, true)
})

test("bash_output / kill_shell / list_shells error without a registry", async () => {
  const output = asCallable(createBashOutputTool({}))
  const kill = asCallable(createKillShellTool({}))
  const list = asCallable(createListShellsTool({}))
  assert.equal((await output.handler({ shellId: "x" }, {})).isError, true)
  assert.equal((await kill.handler({ shellId: "x" }, {})).isError, true)
  assert.equal((await list.handler({}, {})).isError, true)
})

test("bash fails closed without the configured sandbox launcher for foreground and background", async () => {
  let spawned = false
  const bash = asCallable(
    createBashTool({
      cwd: process.cwd(),
      shell: legacyShell,
      builtinProcessSandbox: {
        launcher: "",
        writableRoots: [process.cwd()],
        readableRoots: [],
        network: false,
      },
      // A stub registry: this path must fail before it spawns anything.
      bgShells: {
        spawnBackground() {
          spawned = true
        },
      } as unknown as SessionBgShellRegistry,
    })
  )
  for (const run_in_background of [false, true]) {
    const result = await bash.handler({ command: "echo hello", run_in_background })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /launcher is unavailable/)
  }
  assert.equal(spawned, false)
})

test("bash background jobs retain supervision and launch through the sandbox", async () => {
  let request: { shell: string; shellArgs: string[] } | undefined
  const bash = asCallable(
    createBashTool({
      cwd: process.cwd(),
      shell: legacyShell,
      builtinProcessSandbox: {
        launcher: process.execPath,
        writableRoots: [process.cwd()],
        readableRoots: [],
        network: false,
      },
      // A stub registry recording the spawn request; only spawnBackground is reached.
      bgShells: {
        spawnBackground(input: { shell: string; shellArgs: string[] }) {
          request = input
          return { id: "bg1" }
        },
      } as unknown as SessionBgShellRegistry,
    })
  )
  const result = await bash.handler({ command: "echo hello", run_in_background: true })
  assert.notEqual(result.isError, true)
  assert.equal(request!.shell, process.execPath)
  assert.ok(request!.shellArgs.includes("--writable"))
  assert.equal(request!.shellArgs.includes("--network"), false)
  assert.ok(request!.shellArgs.includes("echo hello"))
})

test("bash foreground and host background jobs receive the final workdir lease", async () => {
  const { withProcessSandbox } = await import("../../../platform/process/exec.ts")
  const { createHostBgShellRegistry } = await import("../../state/host-background-shells.ts")
  const trusted = { COGNIA_PORT: "41000", COGNIA_PORT_COUNT: "10", PORT: "41000" }
  const jobs: Record<string, unknown>[] = []
  const hostRpc = {
    async call(method: string, params: unknown) {
      if (method === "workspace.portEnv") return trusted
      assert.equal(method, "jobs.spawn")
      jobs.push(params as Record<string, unknown>)
      return { id: "ports-job", startedAtMs: 1 }
    },
  }
  const bgShells = createHostBgShellRegistry({ hostRpc, sessionId: "ports" })
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell, bgShells }))
  await withProcessSandbox(
    undefined,
    process.cwd(),
    async () => {
      const command = `${JSON.stringify(process.execPath)} -e "console.log(process.env.COGNIA_PORT,process.env.COGNIA_PORT_COUNT,process.env.PORT)"`
      const foreground = await tool.handler({ command }, {})
      assert.match(textOf(foreground), /41000 10 41000/)
      const background = await tool.handler({ command, run_in_background: true }, {})
      assert.equal(background.isError, undefined)
      const env = jobs[0]!.env as Record<string, string>
      for (const [key, value] of Object.entries(trusted)) assert.equal(env[key], value)
    },
    { hostRpc, sessionId: "ports" }
  )
})

test("bash refuses foreground and background execution on host lease error", async () => {
  const { withProcessSandbox } = await import("../../../platform/process/exec.ts")
  const tool = asCallable(createBashTool({ cwd: os.tmpdir(), shell: legacyShell }))
  for (const run_in_background of [false, true]) {
    const result = await withProcessSandbox(
      undefined,
      os.tmpdir(),
      () => tool.handler({ command: "echo must-not-run", run_in_background }, {}),
      {
        hostRpc: {
          call: async () => {
            throw new Error("lease exhausted")
          },
        },
      }
    )
    assert.equal(result.isError, true)
    assert.match(textOf(result), /lease exhausted/)
  }
})

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test(
  "bash stops the command and the processes it started when the call is interrupted",
  { skip: process.platform === "win32" },
  async () => {
    // LC-01: the shell forks a long-lived worker (the trailing `; true` keeps
    // `sh` from exec-ing it), so killing only the shell left the worker alive.
    const dir = await fsp.mkdtemp(`${os.tmpdir()}/bash-abort-`)
    const pidFile = `${dir}/worker.pid`
    const worker = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)" ${JSON.stringify(pidFile)}; true`
    const tool = asCallable(createBashTool({ cwd: dir, shell: legacyShell }))
    const controller = new AbortController()
    try {
      const pending = tool.handler({ command: worker }, { signal: controller.signal })
      const deadline = Date.now() + 5000
      let workerPid = 0
      while (Date.now() < deadline) {
        const raw = await fsp.readFile(pidFile, "utf-8").catch(() => "")
        if (raw) {
          workerPid = Number(raw)
          break
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(workerPid > 0, "worker never started")
      controller.abort()
      const res = await pending
      assert.equal(res.isError, true)
      assert.match(textOf(res), /interrupted by the user/)
      assert.doesNotMatch(textOf(res), /terminated by signal/)
      assert.equal(processAlive(workerPid), false, "worker survived the interrupt")
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
)

test("bash refuses to start a command whose call was already interrupted", async () => {
  const dir = await fsp.mkdtemp(`${os.tmpdir()}/bash-preabort-`)
  const tool = asCallable(createBashTool({ cwd: dir, shell: legacyShell }))
  const controller = new AbortController()
  controller.abort()
  try {
    const res = await tool.handler({ command: "echo ran > ran.txt" }, { signal: controller.signal })
    assert.equal(res.isError, true)
    assert.match(textOf(res), /never ran/)
    await assert.rejects(fsp.stat(`${dir}/ran.txt`), { code: "ENOENT" })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test(
  "bash timeout also stops the processes the command started",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await fsp.mkdtemp(`${os.tmpdir()}/bash-timeout-tree-`)
    const pidFile = `${dir}/worker.pid`
    const worker = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)" ${JSON.stringify(pidFile)}; true`
    const tool = asCallable(createBashTool({ cwd: dir, shell: legacyShell }))
    try {
      const res = await tool.handler({ command: worker, timeout: 1500 }, {})
      assert.match(textOf(res), /timed out after 1500 ms/)
      const workerPid = Number(await fsp.readFile(pidFile, "utf-8"))
      assert.ok(workerPid > 0)
      assert.equal(processAlive(workerPid), false, "worker survived the timeout")
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
)
