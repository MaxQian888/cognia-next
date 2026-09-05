#!/usr/bin/env node
/**
 * Opt-in real conversation: shipped CLI, real PTY, real model. Requires an
 * explicit backend because this spends tokens. Reuse configuration in a private
 * temp home; never print credentials, raw PTY output or provider error bodies.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const BUNDLE = path.join(REPO_ROOT, "cli/dist/cognia-agent.mjs")
class SmokeError extends Error {}
export const USAGE = `usage: pnpm cli:test:conversation:real -- --backend <id> [--model <id>] [--pi-extension-policy <policy>] [--prompt <text> --expect <answer>] [--timeout <seconds>]

  --backend   Required, e.g. pi-rpc, claude-code, deepseek-harness, builtin.
  --model     Override the selected backend's remembered model.
  --pi-extension-policy  Pi only: isolated, global, or trusted-project.
  --prompt    Single-line question. Custom prompts require --expect.
  --expect    Exact rendered answer line; must not occur in the prompt.
  --timeout   Conversation budget in seconds; defaults to 120.

Reads existing user/project/env configuration from the invocation directory.
This spends real tokens. No backend is inferred and nothing is installed.`

const compact = (value) => value.replace(/\s+/gu, "")

export function parseArgs(argv) {
  const out = {
    timeout: 120,
    prompt: "What is 1847 plus 2939? Reply only with the decimal sum.",
    expect: "4786",
  }
  const fields = {
    "--backend": "backend",
    "--model": "model",
    "--pi-extension-policy": "piExtensionPolicy",
    "--prompt": "prompt",
    "--expect": "expect",
    "--timeout": "timeout",
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") continue
    if (arg === "--help" || arg === "-h") return { help: true }
    const field = fields[arg]
    if (!field) throw new Error("unknown argument; see --help")
    const value = argv[++i]
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} requires a value`)
    out[field] = field === "timeout" ? Number(value) : value
  }
  if (!out.backend) throw new Error("a backend is required")
  if (!Number.isFinite(out.timeout) || out.timeout <= 0)
    throw new Error("--timeout must be a positive number of seconds")
  if (argv.includes("--prompt") && !argv.includes("--expect"))
    throw new Error("custom --prompt requires --expect")
  if (/[\p{Cc}\p{Cf}]/u.test(out.prompt + out.expect) || /^[\/!#@]/u.test(out.prompt))
    throw new Error("prompt and expected answer must be printable single-line conversation text")
  if (compact(out.prompt).includes(compact(out.expect)))
    throw new Error("--expect must not occur in the prompt; ask a question that derives the answer")
  if (
    out.piExtensionPolicy &&
    (out.backend !== "pi-rpc" ||
      !["isolated", "global", "trusted-project"].includes(out.piExtensionPolicy))
  )
    throw new Error("--pi-extension-policy requires pi-rpc and a supported policy")
  return out
}

/** Compile existing screen/config implementations; do not invent another ANSI parser. */
export async function loadSupport(directory) {
  const { build } = await import("esbuild")
  const outfile = path.join(directory, "smoke-support.mjs")
  await build({
    stdin: {
      contents: [
        'export { TerminalScreen } from "./cli/src/tui/pty/terminal-screen.ts";',
        'export { loadConfig, resolveConfig } from "./cli/src/config/load.ts";',
        'export { cliConfigFileSchema } from "./cli/src/config/schema.ts";',
        'export { BUILTIN_EXECUTABLE_PRESET_IDS } from "./lib/ai/agent/external/presets.ts";',
      ].join("\n"),
      resolveDir: REPO_ROOT,
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    tsconfig: path.join(REPO_ROOT, "tsconfig.json"),
    banner: {
      js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(REPO_ROOT, "package.json"))});`,
    },
    logLevel: "silent",
  })
  return import(pathToFileURL(outfile).href)
}

export function snapshotConfig(resolved, schema, args, workspace) {
  const config = Object.fromEntries(
    Object.keys(schema.shape)
      .filter((key) => resolved[key] !== undefined)
      .map((key) => [key, structuredClone(resolved[key])])
  )
  config.cwd = workspace
  config.agentBackend = args.backend
  if (args.backend === "builtin") {
    if (args.model) {
      config.model = args.model
      config.providers = {
        ...config.providers,
        [config.provider]: { ...config.providers?.[config.provider], model: args.model },
      }
    }
  } else {
    config.agentBackends = {
      ...config.agentBackends,
      [args.backend]: {
        ...config.agentBackends?.[args.backend],
        ...(args.model ? { model: args.model } : {}),
        ...(args.piExtensionPolicy ? { piExtensionPolicy: args.piExtensionPolicy } : {}),
      },
    }
  }
  return schema.parse(config)
}

export function hasFinalAnswer(screen, expected) {
  return (
    screen.flatText().includes("Ask, run") &&
    screen.lines().some((line) => line.trim() === expected.trim())
  )
}

/** Require a fresh rendered frame for every character, including spaces. */
export async function typeRendered(terminal, screen, waitFor, prompt, revision) {
  let typed = ""
  for (const char of prompt) {
    const before = revision()
    terminal.write(char)
    typed += char
    await waitFor(
      () => revision() > before && compact(screen.text()).includes(compact(`› ${typed}`)),
      `composer character ${[...typed].length}`
    )
  }
  terminal.write("\r")
}

export async function converse({ terminal, screen, prompt, expected, timeoutMs }) {
  let revision = 0
  let exited = false
  let exitCode
  terminal.onData((chunk) => {
    screen.write(chunk)
    revision++
  })
  terminal.onExit((event) => {
    exited = true
    exitCode = event.exitCode
  })
  const waitFor = async (check, label, deadline = Date.now() + timeoutMs, allowExit = false) => {
    while (!check()) {
      if ((!allowExit && exited) || Date.now() >= deadline)
        throw new SmokeError(
          `failed waiting for ${label}${exited ? " (process exited)" : " (timeout)"}`
        )
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const deadline = Date.now() + timeoutMs
  const wait = (check, label) => waitFor(check, label, deadline)
  let failure
  try {
    await wait(() => /Do you trust|Ask, run/u.test(screen.flatText()), "workspace gate or composer")
    if (screen.flatText().includes("Do you trust")) terminal.write("\r")
    await wait(() => screen.flatText().includes("Ask, run"), "composer")
    await typeRendered(terminal, screen, wait, prompt, () => revision)
    await wait(() => hasFinalAnswer(screen, expected), "the final answer and idle composer")
  } catch (error) {
    failure = error
  } finally {
    // Signal the app's cleanup without racing two input chunks.
    if (!exited) terminal.kill("SIGINT")
    try {
      await waitFor(() => exited, "terminal shutdown", Date.now() + 5000, true)
    } catch {
      terminal.kill("SIGKILL")
      failure ??= new SmokeError("terminal did not shut down cleanly")
    }
  }
  if (failure) throw failure
  if (screen.altScreen || !screen.cursorVisible || screen.mouseModes.size)
    throw new SmokeError("terminal modes were not restored")
  if (exitCode !== 0 && exitCode !== 130) throw new SmokeError("CLI exited unsuccessfully")
}

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!fs.existsSync(BUNDLE)) {
    process.stderr.write(
      "CLI bundle is missing; run rtk node scripts/build/build-cli.mjs --js-only\n"
    )
    return 2
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-real-"))
  fs.chmodSync(workspace, 0o700)
  try {
    const support = await loadSupport(workspace)
    if (args.backend !== "builtin" && !support.BUILTIN_EXECUTABLE_PRESET_IDS.includes(args.backend))
      throw new SmokeError("unknown executable backend; see the CLI backend selection")
    let config
    try {
      config = snapshotConfig(support.loadConfig(), support.cliConfigFileSchema, args, workspace)
    } catch {
      throw new SmokeError(
        "could not resolve existing CLI configuration; check user/project configuration"
      )
    }
    // This command manages only DeepSeek. Other presets are checked by connect.
    if (args.backend === "deepseek-harness") {
      const doctor = spawnSync(process.execPath, [BUNDLE, "backend", "doctor", args.backend], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 60_000,
        stdio: "ignore",
      })
      if (doctor.status !== 0)
        throw new SmokeError("deepseek-harness doctor failed; install/configure it first")
    }
    const home = path.join(workspace, "home")
    fs.mkdirSync(home, { mode: 0o700 })
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config), { mode: 0o600 })
    const { default: pty } = await import("node-pty")
    const geometry = { columns: Math.max(100, [...args.prompt].length * 2 + 10), rows: 40 }
    const terminal = pty.spawn(
      process.execPath,
      [
        BUNDLE,
        "chat",
        "--backend",
        args.backend,
        ...(args.backend === "builtin" && args.model ? ["--model", args.model] : []),
        "--cwd",
        workspace,
      ],
      {
        name: "xterm-256color",
        cols: geometry.columns,
        rows: geometry.rows,
        cwd: workspace,
        env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1", COGNIA_HOME: home },
      }
    )
    await converse({
      terminal,
      screen: new support.TerminalScreen(geometry),
      prompt: args.prompt,
      expected: args.expect,
      timeoutMs: args.timeout * 1000,
    })
    process.stdout.write(
      "OK: selected backend rendered the expected answer and restored terminal modes.\n"
    )
    return 0
  } catch (error) {
    process.stderr.write(
      `FAILED: ${error instanceof SmokeError ? error.message : "smoke setup failed; check installed backend and local dependencies"}\n`
    )
    return 1
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
