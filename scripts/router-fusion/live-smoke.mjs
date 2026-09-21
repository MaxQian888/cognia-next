#!/usr/bin/env node
// Router + Fusion live smoke harness (ADR-0188 D4/D20, B5 WP-E3).
//
//   pnpm router-fusion:live-smoke                    dry run: print providers + planned cases, no network
//   pnpm router-fusion:live-smoke --fake             every case against the Fake Provider ("simulated")
//   pnpm router-fusion:live-smoke --settings <export.json> --providers a,b --confirm
//                                                    every case against the confirmed providers ("live"),
//                                                    under a ledger-enforced $5 total cap
//
// The harness is `lib/router-fusion/live/live-smoke-cli.ts`. It reuses the
// app's TypeScript engine (router, ledger, orchestrator), which Node cannot
// run from source here (the root is CommonJS, `@/` and `@cognia/*` are
// tsconfig aliases), so it is bundled with the SAME esbuild pipeline as the
// `cognia-agent` CLI (scripts/build/esbuild-shared.mjs) into a per-run
// directory under node_modules/.cache, run, and the directory removed. This
// file owns every Node built-in the harness needs and hands them in as the
// `LiveSmokeIo` port.
//
// Rule 14 of the Router + Fusion handoff: never run --confirm without the
// user's explicit confirmation of the provider list; the total is capped at $5.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { cliEsbuildOptions, loadEsbuild } from "../build/esbuild-shared.mjs"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const HARNESS_ENTRY = path.join(ROOT, "lib/router-fusion/live/live-smoke-cli.ts")
export const BUNDLE_CACHE = path.join(ROOT, "node_modules/.cache/router-fusion-live-smoke")

/**
 * Bundle the harness into `outdir` and return the entry module's path. The
 * bundle has to live inside the repository so its npm imports (kept external,
 * as in the CLI bundle) resolve from the root node_modules.
 */
export async function buildHarness(outdir) {
  const esbuild = await loadEsbuild()
  fs.rmSync(outdir, { recursive: true, force: true })
  await esbuild.build({
    ...cliEsbuildOptions({
      root: ROOT,
      entry: HARNESS_ENTRY,
      outdir,
      entryNames: "live-smoke",
      banner: false,
    }),
    logLevel: "warning",
  })
  return path.join(outdir, "live-smoke.mjs")
}

/** The file system, as the harness's `LiveSmokeIo` port. */
export function nodeIo() {
  return {
    tempRoot: os.tmpdir(),
    resolvePath: (...segments) => path.resolve(...segments),
    readText: (file) => fs.promises.readFile(file, "utf8"),
    async writeText(file, content) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, content, "utf8")
    },
    makeTempDir: (prefix) => fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)),
  }
}

function writer(stream) {
  return (line) => {
    stream.write(`${line}\n`)
  }
}

/** Resolves once everything written to `stream` so far has been handed to the OS. */
function drained(stream) {
  return new Promise((resolve) => stream.write("", () => resolve()))
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const outdir = path.join(BUNDLE_CACHE, `${process.pid}-${Date.now()}`)
  try {
    const bundle = await buildHarness(outdir)
    const harness = await import(pathToFileURL(bundle).href)
    return await harness.runLiveSmokeCli({
      argv,
      env,
      io: nodeIo(),
      out: writer(process.stdout),
      err: writer(process.stderr),
    })
  } finally {
    // The harness's lazy chunks are loaded by now; the bundle is not reused.
    fs.rmSync(outdir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1
  try {
    code = await main()
  } catch (error) {
    process.stderr.write(
      `live-smoke: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
  }
  await Promise.all([drained(process.stdout), drained(process.stderr)])
  // Explicit: a Dexie or timer handle left by the engine must not keep a
  // finished smoke alive.
  process.exit(code)
}
