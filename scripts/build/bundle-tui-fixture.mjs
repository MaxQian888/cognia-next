// Bundle the PTY test fixture (cli/src/tui/pty/tui-app-fixture.tsx) with the
// SAME esbuild pipeline as the shipped CLI, into cli/dist/tui-app-fixture.mjs.
//
// The node-pty harness used to run the fixture through `tsx`. That never
// exercised the shipped artifact and, worse, ran the graph unfolded, so the
// CJS/ESM boundary shims that crash a from-source run but not the bundle were
// invisible to the matrix (see scripts/build/dev-cli.mjs). The harness now
// spawns this script and runs the bundle.
//
// Cached by mtime: the bundle is rebuilt when any source under cli/src, lib,
// types or packages/*/src, or this pipeline itself, is newer than it.
// `COGNIA_PTY_FIXTURE_REBUILD=1` forces a rebuild. Prints the bundle path.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { cliEsbuildOptions, loadEsbuild } from "./esbuild-shared.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const entry = path.join(root, "cli/src/tui/pty/tui-app-fixture.tsx")
const outdir = path.join(root, "cli/dist")
export const bundlePath = path.join(outdir, "tui-app-fixture.mjs")

const SOURCE_ROOTS = ["cli/src", "lib", "types", "scripts/build"]
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|json)$/

function newestMtime(dir) {
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (SOURCE_EXT.test(entry.name)) {
        const mtime = fs.statSync(full).mtimeMs
        if (mtime > newest) newest = mtime
      }
    }
  }
  return newest
}

export function isStale() {
  if (process.env.COGNIA_PTY_FIXTURE_REBUILD === "1") return true
  if (!fs.existsSync(bundlePath)) return true
  const built = fs.statSync(bundlePath).mtimeMs
  return SOURCE_ROOTS.some((rel) => newestMtime(path.join(root, rel)) > built)
}

export async function ensureFixtureBundle() {
  if (isStale()) {
    const esbuild = await loadEsbuild()
    await esbuild.build({
      ...cliEsbuildOptions({ root, entry, outdir, entryNames: "tui-app-fixture", banner: false }),
      logLevel: "warning",
    })
  }
  return bundlePath
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const built = await ensureFixtureBundle()
  process.stdout.write(`${built}\n`)
}
