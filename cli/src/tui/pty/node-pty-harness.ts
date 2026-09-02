import { spawn as spawnProcess, spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import * as pty from "node-pty"

export interface PtyGeometry {
  columns: number
  rows: number
}

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const FIXTURE_BUNDLER = path.join(REPO_ROOT, "scripts/build/bundle-tui-fixture.mjs")

let fixtureBundle: string | undefined

/**
 * The fixture runs as a BUNDLE built with the shipped CLI's esbuild pipeline,
 * not from source through a TypeScript loader. From-source runs leave the
 * CJS/ESM boundary shims unfolded and can crash where the shipped artifact
 * does not (see scripts/build/dev-cli.mjs), so a matrix that ran them proved
 * little about the binary users get. The bundler script caches by mtime, so a
 * warm run is a stat walk. Memoized per process.
 */
export function fixtureArgs(): string[] {
  if (!fixtureBundle) {
    const built = spawnSync(process.execPath, [FIXTURE_BUNDLER], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      timeout: 120_000,
    })
    if (built.status !== 0) {
      throw new Error(
        `bundle-tui-fixture failed (${built.status}):\n${built.stderr}\n${built.stdout}`
      )
    }
    fixtureBundle = built.stdout.trim().split("\n").pop()
    if (!fixtureBundle) throw new Error("bundle-tui-fixture printed no bundle path")
  }
  return [fixtureBundle]
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

/** Probe in a disposable process because an incompatible native binding can
 * terminate its host while constructing a PTY instead of throwing cleanly. */
export function nodePtyAvailable(): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      'try{const p=require("node-pty");const x=p.spawn("/bin/sh",["-c","exit 0"],{name:"xterm",cols:20,rows:8,cwd:process.cwd(),env:process.env});x.onExit(()=>process.exit(0));setTimeout(()=>process.exit(1),1000)}catch{process.exit(1)}',
    ],
    { cwd: process.cwd(), env: process.env, stdio: "ignore", timeout: 2_000 }
  )
  return probe.status === 0
}

/**
 * Drive the fixture on its OWN markers rather than fixed delays. The old
 * choreography wrote the prompt, the wheel event and the resize in one burst
 * and sent SIGINT 20 ms later. The reply and the resize probe never had a
 * chance to render on a cold process, from source or bundled, so the matrix
 * was asserting a race. Each stage now waits for the output that proves the
 * previous one landed, bounded by one overall timeout.
 */
/**
 * The fixture's output with terminal control stripped and whitespace
 * collapsed, so a marker that a narrow terminal wrapped across lines still
 * reads as one phrase. Both the harness's own waits and the matrix's
 * assertions look at this, never at raw bytes, for text content.
 */
export function visibleText(output: string): string {
  return output
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\s+/g, " ")
}

export async function runPtyScenario(initial: PtyGeometry, resized: PtyGeometry): Promise<string> {
  const terminal = pty.spawn(process.execPath, fixtureArgs(), {
    name: "xterm-256color",
    cols: initial.columns,
    rows: initial.rows,
    cwd: process.cwd(),
    env: { ...stringEnv(process.env), TERM: "xterm-256color" },
  })
  let output = ""
  const waiters: Array<{ marker: string; resolve: () => void }> = []
  const seen = (marker: string) => visibleText(output).includes(marker)
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (seen(waiter.marker)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }
  const waitFor = (marker: string) =>
    new Promise<void>((resolve) => {
      if (seen(marker)) resolve()
      else waiters.push({ marker, resolve })
    })
  const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()))
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
  terminal.onData((chunk) => {
    output += chunk
    notify()
  })

  const drive = (async () => {
    await waitFor(`READY ${initial.columns}x${initial.rows}`)
    // Keystrokes, not a chunk: the keymap treats text that arrives together
    // with its newline as a PASTE and inserts the newline instead of sending
    // (cli/src/tui/input/keymap.ts), exactly as a terminal user never sees.
    terminal.write("hello")
    await waitFor("hello")
    // Let the composer's read loop drain before Enter so the two writes can
    // never coalesce into one "hello\r" chunk on the child's stdin.
    await settle()
    terminal.write("\r")
    await waitFor("deterministic reply")
    terminal.write("\x1b[<64;1;1M")
    terminal.resize(resized.columns, resized.rows)
    await waitFor(`RESIZE ${resized.columns}x${resized.rows}`)
    terminal.kill("SIGINT")
    await exited
  })()

  let timeout: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      terminal.kill()
      reject(new Error(`PTY scenario timed out; output so far:\n${output}`))
    }, 10_000)
  })
  try {
    await Promise.race([drive, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  return output
}

export async function runNonTtyScenario(term = "dumb"): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawnProcess(process.execPath, fixtureArgs(), {
      env: { ...process.env, TERM: term },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk) => (output += chunk.toString()))
    child.stderr.on("data", (chunk) => (output += chunk.toString()))
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`non-TTY fixture exited ${code}`))
    )
  })
}
