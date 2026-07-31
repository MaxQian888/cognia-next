#!/usr/bin/env node
/**
 * Bundle the `cognia plugin import` converter into a single ESM file that
 * the Rust CLI embeds with `include_str!`.
 *
 * Why a checked-in build artifact:
 *
 *   - The converter must reuse the TypeScript parsers that already know
 *     each agent's MCP config quirks and the SKILL.md frontmatter format.
 *     Re-implementing those in Rust would be a second surface to keep in
 *     sync — the defect class that produced the hand-copied parity lists
 *     in `cmd_lint.rs`.
 *   - `cognia` must stay a single self-contained binary, and the CI job
 *     that runs `cargo test -p cognia-cli` deliberately has no Node or
 *     pnpm. Generating the bundle from `build.rs` would break both.
 *
 * The cost of a checked-in artifact is drift, so `--check` re-bundles and
 * compares. `pnpm gate:convert-bundle` runs it in CI.
 *
 * Usage:
 *   node scripts/plugin/build-convert-bundle.mjs           # write
 *   node scripts/plugin/build-convert-bundle.mjs --check   # verify only
 */

import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const ENTRY = resolve(repoRoot, "lib/plugin/convert/bin.ts")
export const OUTFILE = resolve(repoRoot, "crates/cognia-cli/assets/plugin-convert.cjs")

const BANNER = `// GENERATED FILE — do not edit.
// Source: lib/plugin/convert/**  ·  Rebuild: pnpm plugin-convert:bundle
// Verified in CI by: pnpm gate:convert-bundle
`

/**
 * Modules the converter never executes but that sit on an import path it
 * touches. `skills-io` dynamic-imports the Tauri filesystem plugin and the
 * Dexie-backed bundle loader inside `resolveSkillMarkdown`, which the
 * converter does not call; bundling them would drag IndexedDB and the
 * Tauri runtime into a plain Node script.
 */
/**
 * Host modules the converter never executes but that sit on an import
 * path it touches, replaced with a stub instead of bundled.
 *
 * `esbuild`'s `alias` option rewrites `@/…` to an absolute path *before*
 * `external` patterns are matched, so listing these under `external` is
 * silently ineffective. A resolve plugin is the only place the original
 * specifier is still visible.
 *
 * Each stub states the truth for a Node CLI rather than throwing:
 * `isTauri()` really is false here, and `resolveSkillMarkdown` — the only
 * consumer of the Dexie-backed bundle loader — is never called by the
 * converter.
 */
const unavailable = (module, names) =>
  names
    .map(
      (name) =>
        `export const ${name} = () => { throw new Error("${module}.${name} is unavailable in the plugin-import CLI") }`
    )
    .join("\n")

const STUBS = {
  "@/lib/tauri": "export const isTauri = () => false\n",
  // Dynamically imported inside `resolveSkillMarkdown` / the bundle
  // walkers, neither of which the converter calls: it reads SKILL.md
  // through its own injected `ConvertIo`, not through the desktop bridge.
  "@tauri-apps/plugin-fs": unavailable("@tauri-apps/plugin-fs", [
    "readTextFile",
    "readFile",
    "writeTextFile",
    "readDir",
    "exists",
    "stat",
    "mkdir",
  ]),
  "@/lib/skills/bundle/loader": unavailable("@/lib/skills/bundle/loader", ["loadBundle"]),
}

/** Module specifiers that must never appear in the bundle. */
const FORBIDDEN = [/^@tauri-apps\//, /^dexie$/]

const cutHostModules = {
  name: "cut-host-modules",
  setup(build) {
    for (const [specifier, contents] of Object.entries(STUBS)) {
      const filter = new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "convert-stub",
      }))
      build.onLoad({ filter, namespace: "convert-stub" }, () => ({
        contents,
        loader: "js",
      }))
    }
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null
      for (const pattern of FORBIDDEN) {
        if (pattern.test(args.path)) {
          throw new Error(
            `"${args.path}" reached the converter bundle (imported by ${args.importer}). ` +
              "Add a stub in scripts/plugin/build-convert-bundle.mjs or break the import."
          )
        }
      }
      return null
    })
  },
}

export async function bundle() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: OUTFILE,
    write: false,
    banner: { js: BANNER },
    plugins: [cutHostModules],
    alias: { "@": repoRoot },
    logLevel: "warning",
    legalComments: "none",
  })
  const file = result.outputFiles?.[0]
  if (!file) throw new Error("esbuild produced no output")
  return file.text
}

function readExisting() {
  try {
    return readFileSync(OUTFILE, "utf8")
  } catch {
    return null
  }
}

async function main() {
  const check = process.argv.includes("--check")
  const next = await bundle()

  if (check) {
    const current = readExisting()
    if (current === next) {
      process.stdout.write("convert bundle is up to date\n")
      return
    }
    process.stderr.write(
      `${OUTFILE} is stale.\n` +
        "The embedded converter no longer matches lib/plugin/convert/**.\n" +
        "Run `pnpm plugin-convert:bundle` and commit the result.\n"
    )
    process.exitCode = 1
    return
  }

  mkdirSync(dirname(OUTFILE), { recursive: true })
  writeFileSync(OUTFILE, next, "utf8")
  process.stdout.write(`wrote ${OUTFILE} (${next.length} bytes)\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
