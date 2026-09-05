/** @jest-environment node */
/**
 * The ONE test that executes the shipped artifact. Everything else in the CLI
 * suite imports TypeScript through Jest's CJS transform, which folds nothing
 * and stubs the rest, so an ESM/CJS boundary that crashes
 * `cli/dist/cognia-agent.mjs` at startup ("does not provide an export named
 * …") was invisible until a user ran the binary. This bundles the JavaScript
 * once (module-level cache), with the production esbuild pipeline, and runs
 * the real file.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(__dirname, "../../..")
const BUNDLE = path.join(REPO_ROOT, "cli/dist/cognia-agent.mjs")

function run(args: string[], stdin?: string) {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
    ...(stdin === undefined ? {} : { input: stdin }),
  })
}

/**
 * The same run, with a private HOME.
 *
 * The readline REPL reads config and the approval store out of HOME, so a run
 * against the developer's own would take their settings and could write to
 * them. An isolated one is also the only way the result means anything on
 * another machine.
 */
function runIsolated(args: string[], stdin?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-bundle-"))
  try {
    return spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: home,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        HOME: home,
        USERPROFILE: home,
        COGNIA_HOME: path.join(home, ".cognia"),
      },
      timeout: 60_000,
      ...(stdin === undefined ? {} : { input: stdin }),
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

describe("cognia-agent bundle", () => {
  jest.setTimeout(240_000)

  beforeAll(() => {
    const built = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts/build/build-cli.mjs"), "--js-only"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 200_000 }
    )
    if (built.status !== 0) {
      throw new Error(
        `build-cli --js-only failed (${built.status}):\n${built.stderr}\n${built.stdout}`
      )
    }
  })

  it("prints its version", () => {
    const result = run(["--version"])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("prints help", () => {
    const result = run(["--help"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("cognia-agent")
    expect(result.stdout).toContain("Usage:")
  })

  it("prints the x subcommand help", () => {
    const result = run(["x", "--help"])
    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/claude|codex/)
  })

  it("exits 2 on an unknown command", () => {
    const result = run(["definitely-not-a-command"])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("unknown command")
  })

  /**
   * The non-TTY conversation, in the shipped artifact.
   *
   * Piped stdin takes a completely different path from the Ink TUI: a readline
   * REPL with its own command set, its own permission prompt and its own exit
   * codes. Every test for it ran in-process against injected dependencies, so
   * nothing proved the branch was still reachable once bundled, and a lazy
   * import that only resolves on a TTY is exactly the kind of thing that
   * breaks here and nowhere else.
   */
  describe("piped stdin", () => {
    it("runs the readline REPL and exits cleanly at EOF", () => {
      const result = runIsolated(["chat"], "/help\n")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("cognia-agent — interactive")
      expect(result.stdout).toContain("/handoff")
    })

    it("takes several lines in one pipe", () => {
      const result = runIsolated(["chat"], "/help\n/clear\n/exit\n")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("Started a fresh session.")
    })

    it("warns about an unknown command without ending the session", () => {
      const result = runIsolated(["chat"], "/nope\n/help\n")
      expect(result.status).toBe(0)
      expect(result.stderr).toContain("unknown command /nope")
      // The loop stayed alive: the next line was still processed.
      expect(result.stdout).toContain("/handoff")
    })

    it("says that resuming needs a terminal instead of silently starting fresh", () => {
      const result = runIsolated(["chat", "--continue"], "/exit\n")
      expect(result.stderr).toContain("interactive terminal")
    })

    it("never puts the terminal into the alternate screen when it is a pipe", () => {
      const result = runIsolated(["chat"], "/help\n")
      // `?1049` is the alternate screen and `?1000`/`?1002`/`?1006` are mouse
      // reporting. A pipe that received them would corrupt whatever consumes
      // it, and leave a terminal wedged if the pipe was a `tee`.
      expect(result.stdout).not.toContain("?1049")
      expect(result.stdout).not.toContain("?1006")
      expect(result.stdout).not.toContain("?25l")
    })

    it("asks for a prompt rather than running an empty turn", () => {
      const result = runIsolated(["run"], "")
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("a prompt is required")
    })

    it("accepts the prompt from the pipe itself", () => {
      const result = runIsolated(["run"], "summarise this repository\n")
      // No credentials in an isolated HOME, so the turn cannot succeed. What
      // this pins is that the prompt was ACCEPTED: the "a prompt is required"
      // refusal is what a dropped stdin looks like, and it must not appear.
      expect(result.stderr).not.toContain("a prompt is required")
    })
  })
})
