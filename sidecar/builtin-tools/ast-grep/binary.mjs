// Resolve the `ast-grep` (alias `sg`) binary, mirroring `core/rg.mjs`'s policy:
// no bundled binary — probe, in order:
//   1. COGNIA_AST_GREP_PATH env override (explicit user configuration)
//   2. the `@ast-grep/cli` npm package's platform binary, when resolvable from
//      the sidecar's module graph
//   3. `ast-grep` / `sg` on PATH (`where` on win32, `command -v` elsewhere)
//   4. Well-known win32 / cargo install locations
// The result is cached for the process lifetime; callers return a clean
// structured error when this resolves to null (never crash).

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

/** @type {string | null | undefined} undefined = not probed yet */
let cachedPath

/** Reset the cache (tests only). */
export function __resetAstGrepCache() {
  cachedPath = undefined
}

function exeName(base) {
  return process.platform === "win32" ? `${base}.exe` : base
}

/**
 * `@ast-grep/cli` ships the native binary inside a per-platform optional
 * dependency. Map the current platform/arch to that package name so we can
 * resolve its binary the same way esbuild / @vscode/ripgrep do.
 * @returns {string | undefined}
 */
function platformPackage() {
  const key = `${process.platform}-${process.arch}`
  /** @type {Record<string, string>} */
  const map = {
    "darwin-arm64": "@ast-grep/cli-darwin-arm64",
    "darwin-x64": "@ast-grep/cli-darwin-x64",
    "linux-x64": "@ast-grep/cli-linux-x64-gnu",
    "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
    "win32-x64": "@ast-grep/cli-win32-x64-msvc",
    "win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
    "win32-ia32": "@ast-grep/cli-win32-ia32-msvc",
  }
  return map[key]
}

/**
 * Resolve the binary from the installed `@ast-grep/cli` module graph. Tries the
 * platform package first (where the real binary lives), then falls back to a
 * `node_modules/.bin` shim next to the main package.
 * @returns {string | null}
 */
function npmBinaryPath() {
  const require = createRequire(import.meta.url)
  const pkg = platformPackage()
  if (pkg) {
    try {
      const pkgJson = require.resolve(`${pkg}/package.json`)
      const candidate = path.join(path.dirname(pkgJson), exeName("ast-grep"))
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* platform package not installed — fall through */
    }
  }
  // `.bin` shim adjacent to the resolvable main package.
  try {
    const mainPkg = require.resolve("@ast-grep/cli/package.json")
    // node_modules/@ast-grep/cli/package.json → node_modules/.bin/ast-grep
    const nodeModules = path.resolve(path.dirname(mainPkg), "..", "..")
    for (const base of ["ast-grep", "sg"]) {
      const candidate = path.join(nodeModules, ".bin", exeName(base))
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    /* not installed — expected when running from a packaged build */
  }
  return null
}

/**
 * Locate a binary on PATH without blocking the event loop. Mirrors rg.mjs.
 * @param {string} name
 * @returns {Promise<string | null>}
 */
function pathLookup(name) {
  const [cmd, args] =
    process.platform === "win32" ? ["where", [name]] : ["sh", ["-c", `command -v ${name}`]]
  return new Promise((resolve) => {
    let settled = false
    const finish = (val) => {
      if (!settled) {
        settled = true
        resolve(val)
      }
    }
    let child
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
    child.stdout?.on("data", (chunk) => {
      out += chunk
    })
    child.on("error", () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
        if (first && fs.existsSync(first.trim())) return finish(first.trim())
      }
      finish(null)
    })
  })
}

function knownLocations() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? ""
    return [
      home && path.join(home, "scoop", "shims", "ast-grep.exe"),
      home && path.join(home, ".cargo", "bin", "ast-grep.exe"),
      local && path.join(local, "Microsoft", "WinGet", "Links", "ast-grep.exe"),
      "C:\\ProgramData\\chocolatey\\bin\\ast-grep.exe",
    ].filter(Boolean)
  }
  return [home && path.join(home, ".cargo", "bin", "ast-grep")].filter(Boolean)
}

/**
 * Resolve the ast-grep binary path, or null when unavailable. Cached.
 * @returns {Promise<string | null>}
 */
export async function detectAstGrep() {
  if (cachedPath !== undefined) return cachedPath

  const override = process.env.COGNIA_AST_GREP_PATH
  if (override && fs.existsSync(override)) {
    cachedPath = override
    return cachedPath
  }

  cachedPath = npmBinaryPath() ?? (await pathLookup("ast-grep")) ?? (await pathLookup("sg"))
  if (!cachedPath) {
    for (const candidate of knownLocations()) {
      if (fs.existsSync(candidate)) {
        cachedPath = candidate
        break
      }
    }
  }
  if (cachedPath === undefined) cachedPath = null
  return cachedPath
}
