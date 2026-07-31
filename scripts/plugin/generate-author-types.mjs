#!/usr/bin/env node

/**
 * Bundle the author-facing TypeScript declarations the plugin scaffold vendors.
 *
 * Why this exists: none of the `@cognia/*` packages are published (the SDK is a
 * 404 on npm), so a scaffolded plugin project cannot resolve `@cognia/plugin-sdk`
 * or `@cognia/plugin-ui` from any registry — and the template deliberately
 * forbids `skipLibCheck`, so the types have to genuinely resolve. `cognia plugin
 * new` therefore writes the declarations straight into the project and points
 * `tsconfig.json` `paths` at them.
 *
 * The SDK's public type surface reaches into `@cognia/provider-types` (five
 * subpaths) and `@cognia/provider-core/core/client`, so those two packages are
 * vendored alongside it. `provider-routing` is a runtime-only dependency and
 * never appears in the type surface, so it is deliberately absent.
 *
 * Output is one JSON map (relative path -> file contents) checked in at
 * `crates/cognia-cli/assets/author-types.json` and embedded with `include_str!`
 * — the same shape `assets/plugin-convert.cjs` already uses.
 *
 *   Rebuild:  pnpm author-types:bundle
 *   Verify:   pnpm author-types:bundle -- --check   (exits 1 on drift)
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const packagesRoot = join(repoRoot, "packages")
const outputPath = join(repoRoot, "crates/cognia-cli/assets/author-types.json")
const checkOnly = process.argv.includes("--check")

function run(args, cwd, env = {}) {
  execFileSync("pnpm", args, { cwd, stdio: "inherit", env: { ...process.env, ...env } })
}

/** Every `.d.ts` under `dir`, recursively. `.d.cts` is skipped — the scaffold is ESM. */
function collectDeclarations(dir) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".d.ts")) found.push(full)
    }
  }
  if (existsSync(dir)) walk(dir)
  return found.sort()
}

/** POSIX-style relative path, so the generated map is identical on Windows. */
function posixRelative(from, to) {
  return relative(from, to).split(sep).join("/")
}

function build() {
  // provider-types and provider-core are normal standalone builds; both are in
  // `pnpm build:packages`, which is what guarantees they stay `@/`-free.
  run(
    ["--filter", "@cognia/provider-types", "--filter", "@cognia/provider-core", "run", "build"],
    repoRoot
  )

  // The SDK's flattened author declaration is a second, separate dts build —
  // see `packages/plugin-sdk/tsup.author-types.config.ts` for why the published
  // `dist/` cannot be reused directly.
  run(
    ["exec", "tsup", "--config", "tsup.author-types.config.ts"],
    join(packagesRoot, "plugin-sdk"),
    {
      NODE_OPTIONS: "--max-old-space-size=12288",
    }
  )
  run(["exec", "tsup", "--config", "tsup.author-types.config.ts"], join(packagesRoot, "plugin-ui"))
}

function assemble() {
  /** @type {Record<string, string>} */
  const files = {}

  const single = [
    ["plugin-sdk/.tsup-author-types/cognia-plugin-sdk.d.ts", "types/cognia-plugin-sdk.d.ts"],
    ["plugin-ui/.tsup-author-types/cognia-plugin-ui.d.ts", "types/cognia-plugin-ui.d.ts"],
  ]
  for (const [from, to] of single) {
    const full = join(packagesRoot, from)
    if (!existsSync(full))
      throw new Error(`missing generated declaration: ${from} — run without --check first`)
    files[to] = readFileSync(full, "utf8")
  }

  const trees = [
    ["provider-types/dist", "types/provider-types"],
    ["provider-core/dist", "types/provider-core"],
  ]
  for (const [from, to] of trees) {
    const root = join(packagesRoot, from)
    const declarations = collectDeclarations(root)
    if (declarations.length === 0)
      throw new Error(`no declarations found under ${from} — build it first`)
    for (const file of declarations) {
      files[`${to}/${posixRelative(root, file)}`] = readFileSync(file, "utf8")
    }
  }

  return {
    __generated: "by scripts/plugin/generate-author-types.mjs — do not edit",
    __rebuild: "pnpm author-types:bundle",
    files,
  }
}

/**
 * A comparison key that survives declaration reordering.
 *
 * Two independent sources of churn have to be normalized away, or this gate
 * fails permanently and everyone learns to ignore it:
 *
 *  1. `rollup-plugin-dts` does not emit modules in a stable order, so two
 *     consecutive runs over unchanged sources are byte-different. Comparing the
 *     multiset of trimmed lines is invariant under that reordering.
 *  2. Large inferred unions (`providerId: "openai" | "anthropic" | …`, ~80
 *     members) come out in a different member order each build. Sorting the
 *     alternatives within a line absorbs that.
 *
 * Both are order-only: adding, removing or changing a declaration still moves
 * the key, which is the drift this gate is actually for.
 */
function driftKey(content) {
  return (
    content
      .split("\n")
      // Sort only the quoted alternatives, leaving any `name: ` prefix in place —
      // splitting the whole line on `|` would glue the prefix to whichever member
      // sorted first, silently dropping that member from the comparison.
      .map((line) =>
        line.trim().replace(/"[^"]*"(?:\s*\|\s*"[^"]*")+/g, (union) =>
          union
            .split(/\s*\|\s*/)
            .sort()
            .join(" | ")
        )
      )
      .filter(Boolean)
      .sort()
      .join("\n")
  )
}

if (checkOnly) {
  if (!existsSync(outputPath)) {
    console.error(
      `author-types bundle missing at ${posixRelative(repoRoot, outputPath)} — run: pnpm author-types:bundle`
    )
    process.exit(1)
  }
  build()
  const committed = JSON.parse(readFileSync(outputPath, "utf8")).files ?? {}
  const fresh = assemble().files

  const stale = []
  for (const name of new Set([...Object.keys(committed), ...Object.keys(fresh)])) {
    if (!(name in committed)) stale.push(`added:   ${name}`)
    else if (!(name in fresh)) stale.push(`removed: ${name}`)
    else if (driftKey(committed[name]) !== driftKey(fresh[name])) stale.push(`changed: ${name}`)
  }

  if (stale.length > 0) {
    console.error("author-types bundle is stale — run: pnpm author-types:bundle")
    for (const entry of stale) console.error(`  ${entry}`)
    process.exit(1)
  }
  console.log(`author-types bundle is up to date (${Object.keys(fresh).length} declarations)`)
} else {
  build()
  const payload = assemble()
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`)
  const count = Object.keys(payload.files).length
  const bytes = Object.values(payload.files).reduce((sum, content) => sum + content.length, 0)
  console.log(`author-types bundle: ${count} declarations, ${(bytes / 1024).toFixed(0)} KB`)
}

// The per-package scratch dirs are build output, not artifacts anyone should
// commit; the tsup configs write them under a dot-prefixed name for that reason.
for (const pkg of ["plugin-sdk", "plugin-ui"]) {
  rmSync(join(packagesRoot, pkg, ".tsup-author-types"), { recursive: true, force: true })
}
