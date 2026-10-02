// Bundle the operator CLI into one ESM file. The shared contract and parsers
// under ../../../lib/status are inlined (plain Node cannot import the
// repo-root TypeScript leaves unbuilt); only Node built-ins stay external,
// so the artifact runs with a bare `node` (>= 22).

import { builtinModules } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const result = await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(root, "dist/cognia-status-admin.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "inline",
  metafile: true,
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
})

const inputs = Object.keys(result.metafile.inputs)
for (const needle of ["lib/status/contract.ts", "lib/status/validate.ts", "lib/status/config.ts"]) {
  if (!inputs.some((input) => input.includes(needle))) {
    console.error(`build: expected ${needle} to be bundled`)
    process.exit(1)
  }
}
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
console.log(
  `built dist/cognia-status-admin.mjs (${(bytes / 1024).toFixed(1)} KiB, ${inputs.length} inputs)`
)
