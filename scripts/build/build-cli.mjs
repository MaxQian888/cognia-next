// Bundle the standalone agent CLI into a single Node ESM file.
//
// The CLI lives inside the main TS graph (so it reuses lib/claude/* directly),
// so the bundle pulls a reachable slice of the app's TS. esbuild resolves the
// `@/*` alias via the root tsconfig. A few browser-only modules are aliased to
// Node stubs (mirrors the next.config.ts browser-stub pattern); add more here
// as the bundle surfaces them.
//
// Usage: node scripts/build-cli.mjs   (requires `pnpm add -D esbuild`)

import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"

import { cliEsbuildOptions, loadEsbuild } from "./esbuild-shared.mjs"
import { missingNativeHosts, nativeHostFiles } from "./native-host-files.mjs"
import { stagePiExtension } from "./lib/stage-pi-extension.mjs"
import { stageBuiltinPluginAssets } from "./lib/stage-builtin-plugin-assets.mjs"

const root = path.dirname(fileURLToPath(import.meta.url)) + "/../.."
const entry = path.join(root, "cli/src/cli/entry.ts")
const outdir = path.join(root, "cli/dist")

// `--js-only`: bundle the JavaScript and stop before the native-host copies and
// the asset staging. The bundle-spawn test (cli/src/cli/entry.bundle.test.ts)
// uses it so the one test that runs the shipped artifact does not depend on a
// `cargo build --release` having happened on the machine.
const jsOnly = process.argv.includes("--js-only")

const esbuild = await loadEsbuild()

// The plugin list and the option set are shared with the PTY fixture bundle
// (scripts/build/esbuild-shared.mjs), so both go through one definition.
await esbuild.build(cliEsbuildOptions({ root, entry, outdir, entryNames: "cognia-agent" }))

if (jsOnly) {
  console.log(`build-cli: wrote ${path.relative(root, outdir)}/cognia-agent.mjs (JavaScript only)`)
  process.exit(0)
}

// The helper set comes from the same table that decides what gets built, so a
// layout cannot ship without a helper it was supposed to carry.
const nativeHosts = nativeHostFiles(root, {
  suffix: process.platform === "win32" ? ".exe" : "",
})
for (const helper of missingNativeHosts(nativeHosts, (source) => fs.existsSync(source))) {
  throw new Error(
    `build-cli: missing ${path.relative(root, helper.source)}, run ${helper.hint}`
  )
}
for (const helper of nativeHosts) {
  const destination = path.join(outdir, helper.name)
  fs.copyFileSync(helper.source, destination)
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755)
}

// The bundled Pi extension (ADR-0119) and its digest. Staged into `dist/` so
// the published package ships it under the existing `files: ["dist"]` entry,
// and so `resolvePiExtensionScript`'s walk-up finds it on the first hop from
// the bundle directory. Without it every Pi session on an installed CLI fails
// closed with `extension_handshake_failed` — the extension is what enforces
// Pi's native-tool permission matrix, so it is required, not optional.
// Shared with the pkg and Bun layouts so the three cannot drift; the helper
// also verifies the pin, so a forgotten `pnpm pi:extension:pin` fails the
// build instead of shipping an extension that refuses at runtime.
stagePiExtension({ root, sidecarOutDir: path.join(outdir, "sidecar") })

// The generated built-in plugin chunks (cognia-office/pdf/documents/
// presentations/visualize). They are addressed by a root-relative URL, which
// only resolves against a document origin — under Node the loader could not
// even parse it, so all five failed to enable and the three that declare
// headless support silently lost their agent tools. Staged into `dist/` so the
// published package ships them under the existing `files: ["dist"]` entry and
// the runtime walk-up finds them on the first hop from the bundle directory.
const stagedBuiltinPlugins = stageBuiltinPluginAssets({ root, outDir: outdir })
console.log(
  `build-cli: staged ${stagedBuiltinPlugins.pluginIds.length} built-in plugin chunk(s) → ${path.relative(root, stagedBuiltinPlugins.dir)}`
)

console.log(`build-cli: wrote ${path.relative(root, outdir)}/cognia-agent.js`)
