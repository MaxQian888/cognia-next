// Ripgrep detection + execution for the core grep/glob tools.
//
// Engine policy (user decision): no bundled binary. We probe, in order:
//   1. COGNIA_RG_PATH env override (explicit user configuration)
//   2. @vscode/ripgrep, when resolvable from the sidecar's module graph
//   3. `rg` on PATH (`where` on win32, `command -v` elsewhere)
//   4. Well-known win32 install locations (scoop/chocolatey/winget/VS Code)
// The result is cached for the process lifetime; `js-search.ts` is the
// fallback engine when this resolves to null.

import { spawnInProcessSandbox as spawn } from "../../../platform/process/exec.ts"
import fs from "node:fs"
import path from "node:path"

/** `undefined` = not probed yet. */
let cachedPath: string | null | undefined

/** Reset the cache (tests only). */
export function __resetRgCache(): void {
  cachedPath = undefined
}

/**
 * Locate `rg` on PATH without blocking the event loop. The previous `spawnSync`
 * probe stalled the whole sidecar on the first search of a session (a synchronous
 * subprocess with a 5s ceiling); this awaits an async `spawn` instead.
 */
function pathLookup(): Promise<string | null> {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32" ? ["where", ["rg"]] : ["sh", ["-c", "command -v rg"]]
  return new Promise<string | null>((resolve) => {
    let settled = false
    const finish = (val: string | null) => {
      if (!settled) {
        settled = true
        resolve(val)
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      return finish(null)
    }
    let out = ""
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(null)
    }, 5_000)
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += chunk
    })
    child.on("error", () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) {
        const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
        if (first && fs.existsSync(first.trim())) return finish(first.trim())
      }
      finish(null)
    })
  })
}

function knownWin32Locations(): string[] {
  if (process.platform !== "win32") return []
  const home = process.env.USERPROFILE ?? ""
  const local = process.env.LOCALAPPDATA ?? ""
  const programs = process.env.ProgramFiles ?? "C:\\Program Files"
  return [
    home && path.join(home, "scoop", "shims", "rg.exe"),
    local && path.join(local, "Microsoft", "WinGet", "Links", "rg.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\rg.exe",
    // VS Code ships ripgrep with its node_modules.
    path.join(
      programs,
      "Microsoft VS Code",
      "resources",
      "app",
      "node_modules",
      "@vscode",
      "ripgrep",
      "bin",
      "rg.exe"
    ),
    local &&
      path.join(
        local,
        "Programs",
        "Microsoft VS Code",
        "resources",
        "app",
        "node_modules",
        "@vscode",
        "ripgrep",
        "bin",
        "rg.exe"
      ),
  ].filter((p): p is string => Boolean(p))
}

async function vscodeRipgrepPath(): Promise<string | null> {
  try {
    const mod = await import("@vscode/ripgrep")
    const rgPath = mod.rgPath ?? mod.default?.rgPath
    if (typeof rgPath === "string" && fs.existsSync(rgPath)) return rgPath
  } catch {
    /* not installed — expected */
  }
  return null
}

/** Resolve the ripgrep binary path, or null when unavailable. Cached. */
export async function detectRipgrep(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath

  const override = process.env.COGNIA_RG_PATH
  if (override && fs.existsSync(override)) {
    cachedPath = override
    return cachedPath
  }

  cachedPath = (await vscodeRipgrepPath()) ?? (await pathLookup())
  if (!cachedPath) {
    for (const candidate of knownWin32Locations()) {
      if (fs.existsSync(candidate)) {
        cachedPath = candidate
        break
      }
    }
  }
  if (cachedPath === undefined) cachedPath = null
  return cachedPath
}

/**
 * Run ripgrep with an argv array (never a shell string — the pattern must not
 * be able to break out). Resolves `{ stdout, code }`; ripgrep exits 1 for
 * "no matches", which is NOT an error for callers.
 */
export async function runRipgrep(
  rgArgs: string[],
  opts: {
    cwd?: string | undefined
    signal?: AbortSignal | undefined
    maxBuffer?: number | undefined
    rgPath?: string | undefined
    timeoutMs?: number | undefined
  } = {}
): Promise<{ stdout: string; code: number; truncated: boolean }> {
  const bin = opts.rgPath ?? (await detectRipgrep())
  if (!bin) throw new Error("ripgrep is not available")
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024 // 10 MB of output is plenty

  return new Promise<{ stdout: string; code: number; truncated: boolean }>((resolve, reject) => {
    const child = spawn(bin, rgArgs, {
      cwd: opts.cwd,
      signal: opts.signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let truncated = false
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) child.kill()
    }, opts.timeoutMs ?? 30_000)

    // Piped stdio, so both streams exist.
    child.stdout!.on("data", (chunk: Buffer | string) => {
      if (truncated) return
      out += chunk
      if (out.length > maxBuffer) {
        truncated = true
        out = out.slice(0, maxBuffer)
        child.kill()
      }
    })
    let err = ""
    child.stderr!.on("data", (chunk: Buffer | string) => {
      if (err.length < 16 * 1024) err += chunk
    })
    child.on("error", (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // rg: 0 = matches, 1 = no matches, 2 = error. Truncation kills the
      // child, so accept whatever code accompanies a truncated stream.
      if (code === 2 && !truncated) {
        reject(new Error(err.trim() || "ripgrep failed"))
        return
      }
      resolve({ stdout: out, code: code ?? 0, truncated })
    })
  })
}
