import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  DEFAULT_WORKSPACE_RUNTIME_PORT,
  RUNTIME_ENTRY,
  WORKSPACE_RUNTIME_HOST,
  chromiumInstallHint,
  ensureRuntimeSecret,
  prepareRuntimeDirectories,
  repoRoot,
  runtimeDataDir,
  runtimeEnvironment,
  runtimeUrl,
  serverEnvironment,
} from "./workspace-runtime.mjs"

test("the data dir is the one dev:headless uses", async () => {
  assert.equal(runtimeDataDir({ COGNIA_DATA_DIR: "/tmp/elsewhere" }), "/tmp/elsewhere")
  assert.equal(runtimeDataDir({}), path.join(repoRoot, ".cache", "headless"))

  // Both scripts resolve the shared secret file themselves; if headless.mjs
  // ever moves its default, this pair silently stops sharing a secret and the
  // Host authenticates against a runtime that rejects it.
  const headless = await readFile(new URL("./headless.mjs", import.meta.url), "utf8")
  assert.match(headless, /\.cache",\s*options\.localDebug \? "headless-local-debug" : "headless"/)
})

test("the secret is generated once, kept private, and long enough for both halves", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cognia-workspace-runtime-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const first = await ensureRuntimeSecret(dataDir)
  assert.ok(first.length >= 32, first.length)
  const second = await ensureRuntimeSecret(dataDir)
  assert.equal(second, first, "a regenerated secret would desynchronize the two processes")

  const secretPath = path.join(dataDir, "workspace-runtime.secret")
  assert.equal((await readFile(secretPath, "utf8")).trim(), first)
  if (process.platform !== "win32") {
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600)
  }
})

test("the Host is pointed at a loopback runtime, never a routable one", () => {
  const environment = serverEnvironment({ secret: "x".repeat(32) })
  assert.equal(environment.COGNIA_REMOTE_BROWSER_ENABLED, "true")
  assert.equal(
    environment.COGNIA_WORKSPACE_RUNTIME_URL,
    `http://127.0.0.1:${DEFAULT_WORKSPACE_RUNTIME_PORT}`
  )
  assert.equal(environment.COGNIA_WORKSPACE_RUNTIME_SECRET, "x".repeat(32))

  // The Rust locator refuses this pair off loopback, and it is right to: one
  // URL plus one secret means every workspace shares a browser. Binding
  // anywhere else would also expose that browser to the LAN.
  assert.equal(WORKSPACE_RUNTIME_HOST, "127.0.0.1")
  assert.equal(runtimeUrl(1234), "http://127.0.0.1:1234")
})

test("the env names match the ones the Rust locator reads", async () => {
  const rust = await readFile(
    new URL("../../crates/cognia-external-agent/src/workspace_runtime_backend.rs", import.meta.url),
    "utf8"
  )
  assert.match(rust, /WORKSPACE_RUNTIME_URL_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_URL"/)
  assert.match(rust, /WORKSPACE_RUNTIME_SECRET_ENV: &str = "COGNIA_WORKSPACE_RUNTIME_SECRET"/)

  // The runtime process reads the same secret variable — that is why one
  // generated value configures both halves.
  const runtimeMain = await readFile(
    new URL("../../services/workspace-runtime/src/main.mjs", import.meta.url),
    "utf8"
  )
  assert.match(runtimeMain, /process\.env\.COGNIA_WORKSPACE_RUNTIME_SECRET/)
})

test("the runtime is given roots that exist and the overlay the image bakes in", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cognia-workspace-runtime-env-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const environment = runtimeEnvironment({ dataDir, secret: "y".repeat(32) })
  assert.equal(environment.COGNIA_WORKSPACE_RUNTIME_PORT, String(DEFAULT_WORKSPACE_RUNTIME_PORT))
  assert.equal(environment.COGNIA_WORKSPACE_RUNTIME_HOST, "127.0.0.1")
  assert.equal(environment.COGNIA_WORKSPACE_ROOT, path.join(dataDir, "workspaces"))
  assert.equal(environment.COGNIA_BROWSER_PROFILES_ROOT, path.join(dataDir, "browser-profiles"))

  // `main.mjs` reads the overlay at startup and throws if it is missing; the
  // container copies `lib/browser/overlay.injected.js` into its image, and this
  // is the same file read straight from the repo.
  await stat(environment.COGNIA_BROWSER_OVERLAY_PATH)
  await stat(RUNTIME_ENTRY)

  // The runtime expects its roots to exist — the image creates them, nothing
  // on a dev machine does.
  await prepareRuntimeDirectories(environment)
  assert.ok((await stat(environment.COGNIA_WORKSPACE_ROOT)).isDirectory())
  assert.ok((await stat(environment.COGNIA_BROWSER_PROFILES_ROOT)).isDirectory())
})

test("the chromium probe reads the runtime's own playwright, and never throws", async () => {
  // `playwright-core` belongs to the runtime package, not to the repo root —
  // probing it from here reported "not installed" on a machine that had it,
  // which is worse than not probing at all.
  const requireFromRuntime = createRequire(
    path.join(repoRoot, "services", "workspace-runtime", "package.json")
  )
  let installed = false
  try {
    const playwright = await import(
      pathToFileURL(requireFromRuntime.resolve("playwright-core")).href
    )
    const chromium = (playwright.default ?? playwright).chromium
    await stat(chromium.executablePath())
    installed = true
  } catch {
    installed = false
  }

  const hint = await chromiumInstallHint()
  if (installed) {
    assert.equal(hint, null)
  } else {
    // A missing browser is a hint, never a failure: the rest of
    // `dev:web-headless` is unaffected by it.
    assert.match(hint, /playwright install chromium/)
  }
})
