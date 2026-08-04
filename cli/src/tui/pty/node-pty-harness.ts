import { spawn as spawnProcess, spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import * as pty from "node-pty"

export interface PtyGeometry {
  columns: number
  rows: number
}

const FAKE_AGENT_FIXTURE = path.join(__dirname, "fake-agent-fixture.cjs")

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

export async function runPtyScenario(initial: PtyGeometry, resized: PtyGeometry): Promise<string> {
  const terminal = pty.spawn(process.execPath, [FAKE_AGENT_FIXTURE], {
    name: "xterm-256color",
    cols: initial.columns,
    rows: initial.rows,
    cwd: process.cwd(),
    env: { ...stringEnv(process.env), TERM: "xterm-256color" },
  })
  let output = ""
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      terminal.kill()
      reject(new Error("PTY scenario timed out"))
    }, 5_000)
    let driven = false
    terminal.onData((chunk) => {
      output += chunk
      if (!driven && output.includes("READY")) {
        driven = true
        terminal.write("\x1b[<64;1;1M")
        terminal.resize(resized.columns, resized.rows)
        setTimeout(() => terminal.kill("SIGINT"), 20)
      }
    })
    terminal.onExit(() => {
      clearTimeout(timeout)
      resolve(output)
    })
  })
}

export async function runNonTtyScenario(term = "dumb"): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawnProcess(process.execPath, [FAKE_AGENT_FIXTURE], {
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
