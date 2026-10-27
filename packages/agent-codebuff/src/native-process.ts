/** Node-only subprocess policy, separate so its security boundary is testable. */
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { realpathSync } from "node:fs"
import * as path from "node:path"

const nativeSpawn = childProcess.spawn

/** Install before importing the SDK; unsupported MCP cannot spawn its own client. */
export function installCodebuffSubprocessGuard(): () => void {
  const originals = new Map<string, unknown>()
  const api = childProcess as unknown as Record<string, unknown>
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    originals.set(name, api[name])
    api[name] = () => {
      throw new Error("Unbrokered Codebuff subprocess is forbidden")
    }
  }
  syncBuiltinESMExports()
  return () => {
    for (const [name, original] of originals) api[name] = original
    syncBuiltinESMExports()
  }
}

export function spawnCodebuffReadHelper(
  root: string,
  command: string,
  args: readonly string[],
  options?: SpawnOptions
): ChildProcess {
  const name = path.basename(command),
    argv = [...args],
    verb = argv[0] === "-C" ? argv[2] : argv[0]
  const safeGit =
    command === "git" &&
    ["ls-files", "rev-parse", "status", "diff", "log", "show", "ls-tree"].includes(verb ?? "") &&
    !argv.some(
      (arg) =>
        arg === "-c" ||
        /^--(?:config|exec-path|git-dir|work-tree|ext-diff|textconv|output|show-signature|recurse-submodules|no-index)/.test(
          arg
        )
    )
  const safeSearch =
    command === name &&
    /^(?:rg|ripgrep)$/.test(name) &&
    !argv.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))
  if ((!safeGit && !safeSearch) || options?.shell)
    throw new Error("Unsupported unbrokered Codebuff subprocess")
  const cwd = realpathSync(path.resolve(root, String(options?.cwd ?? root)))
  if (cwd !== root && !cwd.startsWith(root + path.sep))
    throw new Error("Codebuff subprocess is outside the workspace")
  if (argv[0] === "-C") {
    const target = realpathSync(path.resolve(cwd, argv[1]))
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error("Codebuff Git workspace escapes its root")
  }
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  }
  if (safeGit && ["diff", "log", "show"].includes(verb)) {
    argv.splice(
      argv[0] === "-C" ? 3 : 1,
      0,
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      ...(verb === "diff" ? [] : ["--no-show-signature"])
    )
  }
  const safeArgs = safeGit
    ? [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "log.showSignature=false",
        ...argv,
      ]
    : ["--no-config", ...argv]
  return nativeSpawn(command, safeArgs, { ...options, cwd, env, shell: false })
}

export function validateCodebuffSearchFlags(flags = ""): string[] {
  const tokens = flags.split(/\s+/).filter(Boolean),
    switches = new Set([
      "-i",
      "--ignore-case",
      "--case-sensitive",
      "-s",
      "-w",
      "--word-regexp",
      "-F",
      "--fixed-strings",
      "--hidden",
    ]),
    values = new Set(["-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C"])
  for (let i = 0; i < tokens.length; i++) {
    if (switches.has(tokens[i])) continue
    if (!values.has(tokens[i]) || !tokens[i + 1] || tokens[i + 1].startsWith("--"))
      throw new Error("Unsupported Codebuff search flags")
    i++
  }
  return tokens
}

/** Native tool implementations have a bounded output and process lifetime. */
export function runCodebuffProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number
): Promise<{ stdout: string; stderr?: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = nativeSpawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        NODE_ENV: process.env.NODE_ENV ?? "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure: Error | undefined,
      killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill("SIGTERM")
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000)
    }
    const timer = setTimeout(
      () => stop(new Error("Codebuff tool timed out")),
      Math.max(1, Math.min(60, timeoutSeconds)) * 1000
    )
    const read = (kind: "stdout" | "stderr", data: Buffer) => {
      bytes += data.byteLength
      if (bytes > 512 * 1024) {
        stop(new Error("Codebuff tool output exceeded the limit"))
        return
      }
      if (kind === "stdout") stdout += data.toString()
      else stderr += data.toString()
    }
    child.stdout?.on("data", (data: Buffer) => read("stdout", data))
    child.stderr?.on("data", (data: Buffer) => read("stderr", data))
    const cleanup = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
    }
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("close", (exitCode) => {
      cleanup()
      if (failure) reject(failure)
      else resolve({ stdout, ...(stderr ? { stderr } : {}), exitCode })
    })
  })
}
