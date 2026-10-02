// Bundle the Node runner into one ESM file: the portable core, the shared
// contract under ../../../lib/status, the signaling synthetic-room helpers and
// `ws` are all inlined. Only Node built-ins stay external, so the artifact
// runs with a bare `node` (>= 22) and nothing else installed.
//
// Plain Node cannot import the repo-root TypeScript leaves unbuilt
// (extensionless relative imports), which is why this is a bundle rather
// than a tsc emit.

import { readFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))

const result = await build({
  entryPoints: [path.join(root, "src/node/main.ts")],
  outfile: path.join(root, "dist/cognia-status-probe.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "inline",
  metafile: true,
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  define: { __PROBE_VERSION__: JSON.stringify(pkg.version) },
  // `ws` is CommonJS and calls require() for Node built-ins; give the ESM
  // bundle a real require so those calls resolve.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __cogniaCreateRequire } from "node:module";',
      "const require = __cogniaCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
})

const inputs = Object.keys(result.metafile.inputs)
const mustInclude = [
  "lib/status/contract.ts",
  "lib/status/signing.ts",
  "lib/signaling/relay-health.ts",
  "synthetic-room.mjs",
  "node_modules/ws",
]
for (const needle of mustInclude) {
  if (!inputs.some((input) => input.includes(needle))) {
    console.error(`build: expected ${needle} to be bundled`)
    process.exit(1)
  }
}
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
console.log(
  `built dist/cognia-status-probe.mjs (${(bytes / 1024).toFixed(1)} KiB, ${inputs.length} inputs)`
)
