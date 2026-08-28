#!/usr/bin/env node

/**
 * The `services/workspace-runtime` process, run on this machine.
 *
 * In a deployment (ADR-0085) there is one runtime container per workspace and
 * `cognia-server` reaches it by name — `COGNIA_WORKSPACE_RUNTIME_URL_TEMPLATE`
 * substitutes the workspace id into a hostname, and each runtime's secret
 * arrives as its own file in `COGNIA_WORKSPACE_RUNTIME_SECRET_DIR`. Neither
 * half of that survives a laptop: nothing resolves the per-workspace hostname,
 * and the workspace id a client sends is a project id minted at runtime, so no
 * script can pre-place its secret file.
 *
 * Development therefore runs ONE runtime on loopback, addressed directly
 * through `COGNIA_WORKSPACE_RUNTIME_URL` with a shared
 * `COGNIA_WORKSPACE_RUNTIME_SECRET` — the same variable the runtime itself
 * reads, so one generated value configures both halves. The Rust side accepts
 * that pair only when the URL names a loopback host.
 */

import { constants as fsConstants } from "node:fs"
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

const scriptPath = fileURLToPath(import.meta.url)
export const repoRoot = path.resolve(path.dirname(scriptPath), "../..")

export const DEFAULT_WORKSPACE_RUNTIME_PORT = 27_910
/** Loopback only. The runtime drives a real browser with no auth beyond the
 *  shared secret, so it must never be reachable from the LAN in dev. */
export const WORKSPACE_RUNTIME_HOST = "127.0.0.1"
export const RUNTIME_ENTRY = path.join(repoRoot, "services", "workspace-runtime", "src", "main.mjs")
/** Same file `dev:headless` defaults to, so both halves agree without env
 *  plumbing between sibling processes. */
const SECRET_FILE = "workspace-runtime.secret"

/** Mirrors `pathsFor` in `headless.mjs`: the dev data dir is where the shared
 *  secret lives, so the two scripts must resolve it identically. */
export function runtimeDataDir(env = process.env) {
  return path.resolve(env.COGNIA_DATA_DIR || path.join(repoRoot, ".cache", "headless"))
}

export function runtimeUrl(port = DEFAULT_WORKSPACE_RUNTIME_PORT) {
  return `http://${WORKSPACE_RUNTIME_HOST}:${port}`
}

/**
 * Read the shared secret, creating it on first use. 64 hex characters — the
 * runtime and the Rust locator both refuse anything under 32.
 */
export async function ensureRuntimeSecret(dataDir) {
  const secretPath = path.join(dataDir, SECRET_FILE)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  try {
    const existing = (await readFile(secretPath, "utf8")).trim()
    if (existing.length >= 32) return existing
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const secret = randomBytes(32).toString("hex")
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600 })
  if (process.platform !== "win32") await chmod(secretPath, 0o600)
  return secret
}

/** What `cognia-server` needs to serve the remote browser against that runtime. */
export function serverEnvironment({ secret, port = DEFAULT_WORKSPACE_RUNTIME_PORT }) {
  return {
    COGNIA_REMOTE_BROWSER_ENABLED: "true",
    COGNIA_WORKSPACE_RUNTIME_URL: runtimeUrl(port),
    COGNIA_WORKSPACE_RUNTIME_SECRET: secret,
  }
}

/**
 * What the runtime process itself needs. The container image bakes these as
 * absolute paths inside its own filesystem; on a dev machine they hang off the
 * headless data dir, and the overlay is read straight out of the repo (the
 * Dockerfile copies that same file in).
 */
export function runtimeEnvironment({ dataDir, secret, port = DEFAULT_WORKSPACE_RUNTIME_PORT }) {
  return {
    COGNIA_WORKSPACE_RUNTIME_SECRET: secret,
    COGNIA_WORKSPACE_RUNTIME_PORT: String(port),
    COGNIA_WORKSPACE_RUNTIME_HOST: WORKSPACE_RUNTIME_HOST,
    COGNIA_WORKSPACE_ROOT: path.join(dataDir, "workspaces"),
    COGNIA_BROWSER_PROFILES_ROOT: path.join(dataDir, "browser-profiles"),
    COGNIA_BROWSER_OVERLAY_PATH: path.join(repoRoot, "lib", "browser", "overlay.injected.js"),
  }
}

/**
 * Create the directories the runtime expects to already exist. The container
 * gets them from its image; here nothing has made them.
 */
export async function prepareRuntimeDirectories(runtimeEnv) {
  for (const key of ["COGNIA_WORKSPACE_ROOT", "COGNIA_BROWSER_PROFILES_ROOT"]) {
    await mkdir(runtimeEnv[key], { recursive: true, mode: 0o700 })
  }
}

/**
 * Chromium is the one dependency this machine may genuinely lack:
 * `playwright-core` ships no browser, and the runtime only discovers that when
 * a user opens the first remote session. Report it at startup — as a warning,
 * not a failure, because the rest of `dev:web-headless` is unaffected.
 */
export async function chromiumInstallHint() {
  try {
    // Resolved from the runtime package, not from here: `playwright-core` is
    // its dependency, and the repo root does not have it.
    const requireFromRuntime = createRequire(
      path.join(repoRoot, "services", "workspace-runtime", "package.json")
    )
    const playwright = await import(
      pathToFileURL(requireFromRuntime.resolve("playwright-core")).href
    )
    // Imported by path, so this CommonJS package arrives as a default export
    // rather than named ones.
    const chromium = (playwright.default ?? playwright).chromium
    await access(chromium.executablePath(), fsConstants.X_OK)
    return null
  } catch {
    return "playwright chromium is not installed; run `pnpm exec playwright install chromium` before opening a remote browser session"
  }
}

export async function prepareWorkspaceRuntime({
  env = process.env,
  port = DEFAULT_WORKSPACE_RUNTIME_PORT,
} = {}) {
  const dataDir = runtimeDataDir(env)
  const secret = await ensureRuntimeSecret(dataDir)
  const runtimeEnv = runtimeEnvironment({ dataDir, secret, port })
  await prepareRuntimeDirectories(runtimeEnv)
  return {
    dataDir,
    port,
    url: runtimeUrl(port),
    runtimeEnv,
    serverEnv: serverEnvironment({ secret, port }),
  }
}

async function main() {
  const port = Number(process.env.COGNIA_WORKSPACE_RUNTIME_PORT ?? DEFAULT_WORKSPACE_RUNTIME_PORT)
  const prepared = await prepareWorkspaceRuntime({ port })
  const hint = await chromiumInstallHint()
  if (hint) process.stderr.write(`[workspace-runtime] ${hint}\n`)
  process.stdout.write(
    `[workspace-runtime] listening on ${prepared.url}\n` +
      `[workspace-runtime] point cognia-server at it with:\n` +
      Object.entries(prepared.serverEnv)
        .map(
          ([key, value]) =>
            `  ${key}=${key.endsWith("SECRET") ? "<in " + path.join(prepared.dataDir, SECRET_FILE) + ">" : value}`
        )
        .join("\n") +
      "\n"
  )
  const child = spawn(process.execPath, [RUNTIME_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, ...prepared.runtimeEnv },
    stdio: "inherit",
  })
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0)
  })
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main()
}
