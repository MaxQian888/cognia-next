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
import path from "node:path"

const REPO_ROOT = path.resolve(__dirname, "../../..")
const BUNDLE = path.join(REPO_ROOT, "cli/dist/cognia-agent.mjs")

function run(args: string[]) {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
  })
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
})
