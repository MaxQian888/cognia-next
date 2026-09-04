import { spawn as spawnProcess, spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"

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
