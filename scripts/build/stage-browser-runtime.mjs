// Stage the local Chromium runtime (ADR-0201) into the Tauri resource tree.
//
// The desktop runs `services/workspace-runtime` in local mode
// (`src/local-main.mjs`) with its bundled Node. An installed app has no
// checkout and no pnpm store, so everything the runtime imports at run time is
// copied into `src-tauri/resources/browser-runtime/` for `bundle.resources`:
//
//   browser-runtime/
//     package.json                        (the runtime's own, for `type`/engines)
//     src/*.mjs                           (runtime source, never the tests)
//     src/overlay.injected.js             (lib/browser/overlay.injected.js, shared
//                                          with the embedded webview)
//     node_modules/playwright-core/**     (dereferenced out of the pnpm store)
//     STAGED.json                         (stamp: input digest + file list)
//
// Chromium itself is NOT staged: the app downloads it on demand with the
// staged `playwright-core` CLI (`browser_local_install`).
//
// Idempotent: the stamp records a digest of every input (the runtime files and
// playwright-core's package.json by content, the rest of playwright-core by
// path and size), so an unchanged tree is a
// no-op and any change restages from scratch — a partial copy is never left
// behind looking complete. The stamp is not a dotfile because Tauri's
// resource globs skip dotfiles.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** Where `bundle.resources` expects the staged tree (relative to the root). */
export const STAGED_RUNTIME_DIR = path.join("src-tauri", "resources", "browser-runtime")
export const STAMP_FILE = "STAGED.json"
export const STAMP_VERSION = 1

/** Files the Rust supervisor requires before it will start the runtime. */
export const REQUIRED_STAGED_ENTRIES = [
  "src/local-main.mjs",
  "src/overlay.injected.js",
  "node_modules/playwright-core/cli.js",
  "node_modules/playwright-core/package.json",
]

function toPosix(relative) {
  return relative.split(path.sep).join("/")
}

/** Runtime source files: `src/**\/*.mjs` except `*.test.mjs`. */
export function runtimeSourceFiles(runtimeDir, fsImpl = fs) {
  const srcDir = path.join(runtimeDir, "src")
  const found = []
  const walk = (dir) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) continue
      found.push(absolute)
    }
  }
  walk(srcDir)
  return found.sort()
}

/** Every file under `dir` (following the top-level symlink pnpm creates). */
function walkFiles(dir, fsImpl) {
  const found = []
  const walk = (current) => {
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const stat = fsImpl.statSync(absolute)
      if (stat.isDirectory()) walk(absolute)
      else if (stat.isFile()) found.push(absolute)
    }
  }
  walk(dir)
  return found.sort()
}

/**
 * The copy plan: `[{ from, to }]` with `to` relative to the staged root.
 * Throws when a required input is missing.
 */
export function planCopies({ root = DEFAULT_ROOT, fsImpl = fs } = {}) {
  const runtimeDir = path.join(root, "services", "workspace-runtime")
  const entry = path.join(runtimeDir, "src", "local-main.mjs")
  if (!fsImpl.existsSync(entry)) {
    throw new Error(
      `stage-browser-runtime: ${path.relative(root, entry)} is missing; the local runtime entrypoint must exist.`
    )
  }
  const overlay = path.join(root, "lib", "browser", "overlay.injected.js")
  if (!fsImpl.existsSync(overlay)) {
    throw new Error(`stage-browser-runtime: ${path.relative(root, overlay)} is missing.`)
  }
  const playwrightLink = path.join(runtimeDir, "node_modules", "playwright-core")
  if (!fsImpl.existsSync(path.join(playwrightLink, "package.json"))) {
    throw new Error(
      "stage-browser-runtime: services/workspace-runtime/node_modules/playwright-core is not installed. Run `pnpm install` from the repo root."
    )
  }
  const playwrightDir = fsImpl.realpathSync(playwrightLink)

  const copies = [
    { from: path.join(runtimeDir, "package.json"), to: "package.json" },
    ...runtimeSourceFiles(runtimeDir, fsImpl).map((from) => ({
      from,
      to: toPosix(path.join("src", path.relative(path.join(runtimeDir, "src"), from))),
    })),
    { from: overlay, to: "src/overlay.injected.js" },
    ...walkFiles(playwrightDir, fsImpl).map((from) => ({
      from,
      to: toPosix(path.join("node_modules", "playwright-core", path.relative(playwrightDir, from))),
    })),
  ]
  return copies
}

/**
 * Digest of the inputs. Runtime-owned files are hashed by content; the
 * playwright-core tree (immutable per version inside the pnpm store) by path
 * and size, plus its package.json by content (the version), which keeps a
 * no-op run fast.
 */
export function inputsDigest(copies, fsImpl = fs) {
  const hash = createHash("sha256")
  for (const { from, to } of copies) {
    hash.update(to)
    hash.update("\0")
    if (to.startsWith("node_modules/") && !to.endsWith("playwright-core/package.json")) {
      hash.update(String(fsImpl.statSync(from).size))
    } else {
      hash.update(fsImpl.readFileSync(from))
    }
    hash.update("\0")
  }
  return hash.digest("hex")
}

function readStamp(outDir, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(outDir, STAMP_FILE), "utf8"))
  } catch {
    return null
  }
}

function stagedTreeIsComplete(outDir, stamp, fsImpl) {
  if (!stamp || !Array.isArray(stamp.files)) return false
  return stamp.files.every((relative) => fsImpl.existsSync(path.join(outDir, relative)))
}

/**
 * Stage the runtime. Returns `{ staged, outDir, digest, files }` where
 * `staged` is false when the existing tree was already current.
 */
export function stageBrowserRuntime({ root = DEFAULT_ROOT, outDir, fsImpl = fs } = {}) {
  const target = outDir ?? path.join(root, STAGED_RUNTIME_DIR)
  const copies = planCopies({ root, fsImpl })
  const digest = inputsDigest(copies, fsImpl)
  const files = copies.map((copy) => copy.to)

  const stamp = readStamp(target, fsImpl)
  if (
    stamp?.version === STAMP_VERSION &&
    stamp.digest === digest &&
    stagedTreeIsComplete(target, stamp, fsImpl)
  ) {
    return { staged: false, outDir: target, digest, files }
  }

  fsImpl.rmSync(target, { recursive: true, force: true })
  for (const { from, to } of copies) {
    const destination = path.join(target, to)
    fsImpl.mkdirSync(path.dirname(destination), { recursive: true })
    fsImpl.copyFileSync(from, destination)
    // Keep the executable bit (playwright's `cli.js`, `bin/*` scripts).
    fsImpl.chmodSync(destination, fsImpl.statSync(from).mode & 0o777)
  }
  for (const required of REQUIRED_STAGED_ENTRIES) {
    if (!fsImpl.existsSync(path.join(target, required))) {
      throw new Error(`stage-browser-runtime: staged tree lacks ${required}.`)
    }
  }
  // The stamp goes last: its presence means the copy finished.
  fsImpl.writeFileSync(
    path.join(target, STAMP_FILE),
    `${JSON.stringify({ version: STAMP_VERSION, digest, files }, null, 2)}\n`
  )
  return { staged: true, outDir: target, digest, files }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { staged, outDir, files } = stageBrowserRuntime()
  const where = path.relative(DEFAULT_ROOT, outDir)
  console.log(
    staged
      ? `[stage-browser-runtime] staged ${files.length} files into ${where}`
      : `[stage-browser-runtime] ${where} is up to date`
  )
}
