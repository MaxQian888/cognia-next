// Dev runner for the `cognia-agent` CLI (`pnpm cli:dev`).
//
// It bundles the CLI with the SAME esbuild pipeline as production
// (scripts/build/build-cli.mjs) and then runs the output, forwarding argv.
//
// Why not `tsx cli/src/cli/entry.ts` (what this used to do)?
// The repo root `package.json` has no `"type": "module"`, so Node/tsx treat the
// app's `.ts` files (lib/**, types/**) as CommonJS, while `cli/` is ESM
// (cli/package.json sets `"type": "module"`). The app exposes the extracted
// `@cognia/*` packages through thin boundary shims like
// `types/ocr/index.ts` → `export * from "@cognia/ocr/types"`. A CommonJS module
// that `export *`s an ESM package produces a runtime re-export that
// cjs-module-lexer cannot see statically, so an ESM consumer in `cli/` importing
// a named value through the shim crashes at startup with
// "does not provide an export named …". esbuild bundles the whole graph into one
// scope, so the CJS/ESM split never arises — which is why the built binary works
// and the from-source tsx path did not.
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const bundler = path.join(root, "scripts/build/build-cli.mjs")
const bundle = path.join(root, "cli/dist/cognia-agent.mjs")

const build = spawnSync(process.execPath, [bundler], { stdio: "inherit" })
if (build.status !== 0) process.exit(build.status ?? 1)

const run = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: "inherit",
})
// Mirror the child's termination: a signal (e.g. Ctrl+C) has no exit code.
if (run.signal) process.kill(process.pid, run.signal)
process.exit(run.status ?? 0)
