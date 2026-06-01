/**
 * Script-type detection + run-request building for the integrated
 * terminal (ADR-0039).
 *
 * "Run this file in the terminal" needs to pick the right interpreter:
 * a `.sh` runs under bash, a `.ps1` under PowerShell `-File`, a `.py`
 * under `python3` (or `python` on Windows), etc. This module owns the
 * pure mapping — extension → interpreter, with a shebang taking
 * precedence — and turns it into a `SpawnRequest` the dock can spawn.
 *
 * Renderer-pure: no fs access. The caller supplies the optional shebang
 * line (read elsewhere) and platform; the Rust side validates the
 * interpreter binary exists at spawn time.
 */

import { detectPlatform, type ShellPlatform } from "./shell-detect"
import type { SpawnRequest } from "./types"

const DEFAULT_ROWS = 24
const DEFAULT_COLS = 80

export interface ScriptType {
  /** Logical language/kind label (drives UI + telemetry). */
  kind: string
  /** Interpreter binary to spawn. */
  interpreter: string
  /** Args inserted before the script path (e.g. `-NoLogo -File` for ps1). */
  interpreterArgs: string[]
}

export interface DetectScriptOptions {
  /** First line of the file, if known — a `#!` shebang wins over the ext. */
  shebang?: string
  /** Platform override (defaults to UA sniff). */
  platform?: ShellPlatform
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? ""
}

function fileExtension(p: string): string {
  const base = basename(p)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "" // no ext, or dotfile like ".bashrc"
  return base.slice(dot + 1).toLowerCase()
}

/** Map an interpreter binary name to a logical kind label. */
function interpreterToKind(interpreter: string): string {
  const base = basename(interpreter)
    .toLowerCase()
    .replace(/\.exe$/, "")
  if (base === "bash" || base === "sh" || base === "dash") return "bash"
  if (base === "zsh") return "zsh"
  if (base === "fish") return "fish"
  if (base === "pwsh" || base === "powershell") return "powershell"
  if (/^python(3|2|w)?(\.\d+)*$/.test(base)) return "python"
  if (base === "node" || base === "nodejs") return "node"
  if (base === "tsx" || base === "ts-node") return "ts"
  if (base === "ruby") return "ruby"
  if (base === "perl") return "perl"
  if (base === "php") return "php"
  if (base === "lua") return "lua"
  if (base === "nu" || base === "nushell") return "nu"
  if (base === "rscript" || base === "r") return "r"
  if (base === "cmd") return "batch"
  return base || "unknown"
}

/** Parse a `#!` shebang line into an interpreter + its flags, or null. */
export function parseShebang(
  line: string
): { interpreter: string; interpreterArgs: string[] } | null {
  if (!line.startsWith("#!")) return null
  const rest = line.slice(2).trim()
  if (rest === "") return null
  const tokens = rest.split(/\s+/)
  let interp = tokens[0]
  let args = tokens.slice(1)
  if (basename(interp) === "env") {
    let idx = 1
    if (tokens[idx] === "-S") idx += 1 // `env -S prog args`
    if (!tokens[idx]) return null
    interp = tokens[idx]
    args = tokens.slice(idx + 1)
  }
  return { interpreter: basename(interp), interpreterArgs: args }
}

/**
 * Determine how to run `scriptPath`. A shebang (if provided) wins;
 * otherwise the file extension is mapped. Returns null when neither
 * yields a known interpreter.
 */
export function detectScriptType(
  scriptPath: string,
  opts: DetectScriptOptions = {}
): ScriptType | null {
  const platform = opts.platform ?? detectPlatform()

  const shebang = opts.shebang ? parseShebang(opts.shebang) : null
  if (shebang) {
    return {
      kind: interpreterToKind(shebang.interpreter),
      interpreter: shebang.interpreter,
      interpreterArgs: shebang.interpreterArgs,
    }
  }

  const ext = fileExtension(scriptPath)
  switch (ext) {
    case "sh":
    case "bash":
      return { kind: "bash", interpreter: "bash", interpreterArgs: [] }
    case "zsh":
      return { kind: "zsh", interpreter: "zsh", interpreterArgs: [] }
    case "fish":
      return { kind: "fish", interpreter: "fish", interpreterArgs: [] }
    case "ps1":
      return { kind: "powershell", interpreter: "pwsh", interpreterArgs: ["-NoLogo", "-File"] }
    case "py":
    case "pyw":
      return {
        kind: "python",
        interpreter: platform === "windows" ? "python" : "python3",
        interpreterArgs: [],
      }
    case "js":
    case "mjs":
    case "cjs":
      return { kind: "node", interpreter: "node", interpreterArgs: [] }
    case "ts":
    case "mts":
    case "cts":
      return { kind: "ts", interpreter: "tsx", interpreterArgs: [] }
    case "rb":
      return { kind: "ruby", interpreter: "ruby", interpreterArgs: [] }
    case "pl":
      return { kind: "perl", interpreter: "perl", interpreterArgs: [] }
    case "php":
      return { kind: "php", interpreter: "php", interpreterArgs: [] }
    case "lua":
      return { kind: "lua", interpreter: "lua", interpreterArgs: [] }
    case "nu":
      return { kind: "nu", interpreter: "nu", interpreterArgs: [] }
    case "r":
      return { kind: "r", interpreter: "Rscript", interpreterArgs: [] }
    case "bat":
    case "cmd":
      return { kind: "batch", interpreter: "cmd", interpreterArgs: ["/c"] }
    default:
      return null
  }
}

export interface BuildScriptSpawnOptions extends DetectScriptOptions {
  /** Explicit interpreter override (bypasses detection). */
  interpreter?: string
  cwd?: string
  /** Args passed to the *script* (after the path). */
  args?: string[]
  env?: Record<string, string>
  rows?: number
  cols?: number
  projectId?: string
}

/**
 * Build a `SpawnRequest` that runs `scriptPath` under the correct
 * interpreter. Throws when the type can't be determined and no explicit
 * interpreter override is given.
 */
export function buildScriptSpawnRequest(
  scriptPath: string,
  opts: BuildScriptSpawnOptions = {}
): SpawnRequest {
  let interpreter: string
  let interpreterArgs: string[]

  if (opts.interpreter && opts.interpreter.trim().length > 0) {
    interpreter = opts.interpreter
    interpreterArgs = []
  } else {
    const type = detectScriptType(scriptPath, { shebang: opts.shebang, platform: opts.platform })
    if (!type) {
      throw new Error(
        `script-runner: cannot determine an interpreter for "${scriptPath}" — pass an explicit interpreter.`
      )
    }
    interpreter = type.interpreter
    interpreterArgs = type.interpreterArgs
  }

  return {
    shell: interpreter,
    args: [...interpreterArgs, scriptPath, ...(opts.args ?? [])],
    cwd: opts.cwd,
    env: opts.env,
    rows: opts.rows ?? DEFAULT_ROWS,
    cols: opts.cols ?? DEFAULT_COLS,
    projectId: opts.projectId,
  }
}
