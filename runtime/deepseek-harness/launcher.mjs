/**
 * Cognia's entry point for a DeepSeek Harness runtime subprocess.
 *
 * DSH publishes no executable for either transport Cognia integrates against:
 * `@deepseek-ai/dsh-acp` and `@deepseek-ai/dsh-sdk-client` are libraries with
 * `"bin": null`, and the one published binary (`@deepseek-ai/dsh`) exposes only
 * `web` and `plugin`. This file is that missing entry point.
 *
 * It is intentionally thin. `@deepseek-ai/dsh-app-boot` already owns root
 * context creation, Loader installation, the include tree mount, the
 * entries-loaded / entries-activated audits, fail-loud diagnostics, and partial
 * tree disposal. Everything here is either argument plumbing or a Cognia trust
 * check that upstream has no reason to make.
 *
 * Usage:
 *   node launcher.mjs <absolute-path-to-host-composition.yml>
 *
 * stdout carries JSON-RPC protocol frames ONLY. Every diagnostic this file
 * emits goes to stderr.
 */

import { realpathSync } from "node:fs"
import { isAbsolute, resolve, sep } from "node:path"

import { boot, installFailLoud } from "@deepseek-ai/dsh-app-boot"

const BIN_NAME = "cognia-dsh"

/**
 * Resolve a path to its canonical filesystem identity.
 *
 * Containment is checked on canonical paths so a symlinked `DSH_HOME` cannot
 * point outside the runtime home while still passing a lexical prefix test.
 * A path that does not exist yet resolves to its lexical form; the caller
 * creates the directory before launch, so this only matters for error paths.
 */
function canonicalize(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * True when `child` is `parent` or sits beneath it.
 *
 * The trailing separator matters: without it `/a/runtime-home-evil` would count
 * as contained in `/a/runtime-home`.
 */
function isContainedIn(child, parent) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Refuse to start unless DSH_HOME is pinned inside the Cognia runtime home.
 *
 * `resolveDshHome()` falls back to `~/.dsh`, and under that root DSH reads
 * `cordis.patch.yml` (home level and per-profile) plus a profile `package.json`
 * whose `dependencies` are out-of-tree plugins. Those layers apply AFTER every
 * bundle layer, may `insert` arbitrary plugin rows, may evaluate arbitrary
 * JavaScript through the `!!js` YAML tag, and are live-watched by
 * `watchUserPatches`.
 *
 * A file in the user's home directory could therefore mount write and network
 * tools onto a profile Cognia certified as read-only, while the lockfile and
 * composition digests still verified. Pinning DSH_HOME into Cognia-owned space
 * is what makes those digests mean anything.
 */
function assertPinnedDshHome() {
  const dshHome = process.env.DSH_HOME
  const runtimeHome = process.env.COGNIA_DSH_RUNTIME_HOME

  if (!runtimeHome) {
    throw new Error(
      "COGNIA_DSH_RUNTIME_HOME is not set. The launcher must be started by Cognia's " +
        "runtime manager, which owns the isolated runtime home."
    )
  }
  if (!dshHome) {
    throw new Error(
      "DSH_HOME is not set. Refusing to start: DeepSeek Harness would fall back to " +
        "~/.dsh, where a user-writable cordis.patch.yml can inject arbitrary plugins " +
        "and arbitrary JavaScript into this composition after digest verification."
    )
  }

  const canonicalHome = canonicalize(dshHome)
  const canonicalRuntimeHome = canonicalize(runtimeHome)

  if (!isContainedIn(canonicalHome, canonicalRuntimeHome)) {
    throw new Error(
      `DSH_HOME (${canonicalHome}) is outside the Cognia runtime home ` +
        `(${canonicalRuntimeHome}). Refusing to start: patch layers under an ` +
        "unmanaged DSH_HOME are not covered by the composition digest."
    )
  }
}

function resolveCompositionPath(argv) {
  const configPath = argv[2]
  if (!configPath) {
    throw new Error("Usage: node launcher.mjs <absolute-path-to-host-composition.yml>")
  }
  if (!isAbsolute(configPath)) {
    // boot() takes an absolute path, and a relative one would resolve against
    // whatever cwd the spawning host happened to have.
    throw new Error(`Composition path must be absolute, received: ${configPath}`)
  }
  return configPath
}

async function main() {
  assertPinnedDshHome()
  const configPath = resolveCompositionPath(process.argv)

  // `bareModuleBaseUrl` anchors bare `@deepseek-ai/dsh-*` specifiers to THIS
  // package tree. Upstream documents it for exactly this case: "a closed runtime
  // passes bareModuleBaseUrl to boot ... so its installed package tree remains
  // authoritative even when the config lives inside another Node project."
  // Without it, a composition sitting inside the Cognia repo could resolve
  // plugins out of Cognia's own node_modules.
  const bareModuleBaseUrl = import.meta.url

  // No `patches` argument: Cognia passes its patch layers explicitly when it
  // needs them, so the runtime never depends on a file layer it does not own.
  await boot(BIN_NAME, configPath, undefined, undefined, bareModuleBaseUrl)
}

// Covers rejections that escape into the event loop after mounting — a plugin's
// detached async work, a Loader rejection. It cannot cover a rejection from the
// top-level `await` below, which Node reports itself, so preflight failures are
// caught explicitly instead.
installFailLoud(BIN_NAME)

try {
  await main()
} catch (err) {
  // One labelled line on stderr, never stdout: a stack trace here would be
  // noise at best, and on a surface where stdout is the protocol it is the
  // launcher's job to keep its own failures legible.
  process.stderr.write(`[${BIN_NAME}] ${err?.message ?? String(err)}\n`)
  process.exit(1)
}
