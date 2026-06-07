// Ripgrep detection + execution for the core grep/glob tools.
//
// Engine policy (user decision): no bundled binary. We probe, in order:
//   1. COGNIA_RG_PATH env override (explicit user configuration)
//   2. @vscode/ripgrep, when resolvable from the sidecar's module graph
//   3. `rg` on PATH (`where` on win32, `command -v` elsewhere)
//   4. Well-known win32 install locations (scoop/chocolatey/winget/VS Code)
// The result is cached for the process lifetime; `js-search.mjs` is the
// fallback engine when this resolves to null.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/** @type {string | null | undefined} undefined = not probed yet */
let cachedPath

/** Reset the cache (tests only). */
export function __resetRgCache() {
  cachedPath = undefined
}

function exeName() {
  return process.platform === "win32" ? "rg.exe" : "rg"
}

function pathLookup() {
  const probe = process.platform === "win32" ? ["where", ["rg"]] : ["sh", ["-c", "command -v rg"]]
  try {
    const res = spawnSync(probe[0], probe[1], { encoding: "utf-8", timeout: 5_000 })
    if (res.status === 0 && typeof res.stdout === "string") {
      const first = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)
      if (first && fs.existsSync(first.trim())) return first.trim()
    }
  } catch {
    /* not on PATH */
  }
  return null
}

function knownWin32Locations() {
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
  ].filter(Boolean)
}

async function vscodeRipgrepPath() {
  try {
    const mod = await import("@vscode/ripgrep")
    const rgPath = mod.rgPath ?? mod.default?.rgPath
    if (typeof rgPath === "string" && fs.existsSync(rgPath)) return rgPath
  } catch {
    /* not installed — expected */
  }
  return null
}

/**
 * Resolve the ripgrep binary path, or null when unavailable. Cached.
 * @returns {Promise<string | null>}
 */
export async function detectRipgrep() {
  if (cachedPath !== undefined) return cachedPath

  const override = process.env.COGNIA_RG_PATH
  if (override && fs.existsSync(override)) {
    cachedPath = override
    return cachedPath
  }

  cachedPath = (await vscodeRipgrepPath()) ?? pathLookup()
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
 *
 * @param {string[]} rgArgs
 * @param {{ cwd?: string, signal?: AbortSignal, maxBuffer?: number, rgPath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ stdout: string, code: number, truncated: boolean }>}
 */
export async function runRipgrep(rgArgs, opts = {}) {
  const bin = opts.rgPath ?? (await detectRipgrep())
  if (!bin) throw new Error("ripgrep is not available")
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024 // 10 MB of output is plenty

  return new Promise((resolve, reject) => {
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

    child.stdout.on("data", (chunk) => {
      if (truncated) return
      out += chunk
      if (out.length > maxBuffer) {
        truncated = true
        out = out.slice(0, maxBuffer)
        child.kill()
      }
    })
    let err = ""
    child.stderr.on("data", (chunk) => {
      if (err.length < 16 * 1024) err += chunk
    })
    child.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
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
