// Bundle + run the external-parity smoke.
//
// Uses the SAME esbuild pipeline as the CLI itself (see scripts/build/dev-cli.mjs
// for why `tsx` cannot run this graph: the repo root is CommonJS while `cli/` is
// ESM, so a `export *` boundary shim breaks a from-source run).
import { spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { createCliExternalAgentAliasPlugin } from "../build/cli-external-agent-aliases.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const entry = path.join(root, "scripts/smoke/external-cognia-parity-smoke.ts")
const outfile = path.join(root, "cli/dist/smoke/external-cognia-parity-smoke.mjs")

const esbuild = await import("esbuild")

// Mirrors build-cli.mjs: the CLI graph incidentally reaches Next-only modules
// that must merely RESOLVE, never execute.
const STUB_PATTERN = /^(next\/|server-only$|client-only$)/
const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({
      path: args.path,
      namespace: "smoke-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "smoke-stub" }, () => ({
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n[\\/]messages[\\/][^\\/]+\.json$/ }, async (args) => {
      const raw = await fs.promises.readFile(args.path, "utf8")
      return { contents: `export default ${raw}`, loader: "js" }
    })
  },
}

fs.mkdirSync(path.dirname(outfile), { recursive: true })
await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  tsconfig: path.join(root, "tsconfig.json"),
  packages: "external",
  loader: {
    ".ttf": "empty",
    ".css": "empty",
    ".svg": "empty",
    ".woff": "empty",
    ".woff2": "empty",
  },
  plugins: [createCliExternalAgentAliasPlugin(root), stubNextPlugin, jsonDefaultOnlyPlugin],
  logLevel: "warning",
})

const smokeArgs = process.argv.slice(2)
if (smokeArgs.includes("--build-only")) {
  process.stdout.write(`built ${path.relative(root, outfile)}\n`)
  process.exit(0)
}

const run = spawnSync(process.execPath, [outfile, ...smokeArgs], { stdio: "inherit" })
process.exit(run.status ?? 1)
