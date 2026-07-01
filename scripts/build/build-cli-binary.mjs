// Build self-contained, per-platform native binaries of the `cognia-agent` CLI.
//
// This is an ADDITIVE pipeline alongside `build-cli.mjs` (which produces the
// npm-style ESM bundle). Here we make a multi-call binary via @yao-pkg/pkg:
// one executable embeds Node + the CLI, and with `COGNIA_ROLE=sidecar` it runs
// the Node sidecar host instead (the CLI self-execs it that way — see
// cli/src/runtime/bootstrap.resolveSpawnTarget). The sidecar ships as files
// next to the binary because its `node-pty` dep is a native addon that cannot
// live inside a JS blob.
//
// The CLI graph reaches Ink / yoga-layout, which use top-level await — illegal
// in CJS output — so the CLI bundle MUST be ESM. But pkg's ESM-from-snapshot
// resolution is broken on Windows. So pkg snapshots a tiny CJS bootstrap (which
// pkg handles reliably) that imports the real ESM `cli.mjs` shipped next to the
// executable. Net: the binary embeds Node; the JS bundles ride alongside it.
//
// Steps:
//   1. esbuild the CLI into an ESM single file, inlining every dep EXCEPT the
//      TUI stack (react/ink/ink-spinner — inlining breaks React's renderer);
//      npm-install those into an adjacent node_modules.
//   2. esbuild the sidecar into an ESM bundle, leaving the bundle-resistant deps
//      external (claude-agent-sdk / node-pty / pdfjs-dist).
//   3. Copy a pruned node_modules (just those externals + their nested deps)
//      next to the sidecar bundle; write the CJS pkg-bootstrap snapshot entry.
//   4. Run pkg once per target (snapshotting the bootstrap).
//   5. Assemble a per-platform dist folder: <binary> + cli.mjs + node_modules/ + sidecar/,
//      then compress it to a shareable archive (.zip for Windows, .tar.gz for unix).
//
// Usage: node scripts/build/build-cli-binary.mjs   (needs esbuild + @yao-pkg/pkg + archiver)

import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"

const root = path.dirname(fileURLToPath(import.meta.url)) + "/../.."
const cliEntry = path.join(root, "cli/src/cli/entry.ts")
const sidecarEntry = path.join(root, "sidecar/claude-host.mjs")
const sidecarNodeModules = path.join(root, "sidecar/node_modules")
const binDir = path.join(root, "cli/dist/bin")
const cliBundle = path.join(binDir, "cli.mjs")
const pkgBootstrap = path.join(binDir, "pkg-bootstrap.cjs")
const sidecarOutDir = path.join(binDir, "sidecar")

// Deps the sidecar bundle keeps external (resolved from the copied node_modules
// at runtime): claude-agent-sdk does dynamic requires / spawns the `claude`
// binary, node-pty is a native addon, pdfjs-dist ships legacy/worker builds.
const SIDECAR_EXTERNALS = [
  "@anthropic-ai/claude-agent-sdk",
  "node-pty",
  "pdfjs-dist",
  // better-sqlite3 is a native addon; web-tree-sitter + tree-sitter-wasms load
  // `.wasm` data files via dynamic require that esbuild can't inline. Keep them
  // external so they're copied next to the binary; the code-graph subsystem
  // degrades gracefully if any are absent.
  "better-sqlite3",
  "web-tree-sitter",
  "tree-sitter-wasms",
]

// The TUI rendering stack MUST stay external. Inlining Ink + react-reconciler +
// scheduler into one bundle breaks React's renderer (the TUI mounts but paints
// nothing and exits). Kept external and shipped as an adjacent node_modules so
// the binary's TUI behaves exactly like a normal `node` install. `react/jsx-*`
// are externalised too (jsx:react-jsx → the bundle imports the runtime), else a
// second inlined React copy sneaks in. Pinned to the repo's resolved versions.
const TUI_EXTERNALS = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "ink", "ink-spinner"]
const TUI_DEPS = ["react@19.2.7", "ink@7.0.5", "ink-spinner@5.0.0"]

// Node 24 (satisfies the repo's >=20 engine). MUST be 24, not 22: pkg-fetch's
// node22 base binary segfaults (access violation) rendering Ink's yoga-layout
// WASM, so the interactive TUI crashes on launch; node24 renders it correctly.
// (node20's win-x64 prebuilt is also absent — it would compile Node from source.)
const TARGETS = [
  { pkg: "node24-win-x64", dist: "cognia-agent-win-x64", bin: "cognia-agent.exe", archive: "zip" },
  { pkg: "node24-linux-x64", dist: "cognia-agent-linux-x64", bin: "cognia-agent", archive: "tar.gz" },
  { pkg: "node24-macos-arm64", dist: "cognia-agent-macos-arm64", bin: "cognia-agent", archive: "tar.gz" },
]

let esbuild
try {
  esbuild = await import("esbuild")
} catch {
  console.error("build-cli-binary: esbuild is not installed. Run: pnpm add -D esbuild")
  process.exit(1)
}

let pkg
try {
  pkg = await import("@yao-pkg/pkg")
} catch {
  console.error("build-cli-binary: @yao-pkg/pkg is not installed. Run: pnpm add -D @yao-pkg/pkg")
  process.exit(1)
}

let archiver
try {
  archiver = (await import("archiver")).default
} catch {
  console.error("build-cli-binary: archiver is not installed. Run: pnpm add -D archiver")
  process.exit(1)
}

// Stream a dist folder into a per-platform archive (zip for Windows, tar.gz for
// unix). The folder is nested under its own name inside the archive, and the
// unix launcher is marked 0755 so it extracts executable (the Windows build host
// has no +x bit to preserve).
function makeArchive(srcDir, format, outFile, execName) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile)
    const archive =
      format === "zip"
        ? archiver("zip", { zlib: { level: 9 } })
        : archiver("tar", { gzip: true, gzipOptions: { level: 9 } })
    output.on("close", () => resolve(archive.pointer()))
    archive.on("warning", (err) => (err.code === "ENOENT" ? undefined : reject(err)))
    archive.on("error", reject)
    archive.pipe(output)
    archive.directory(srcDir, path.basename(srcDir), (entry) => {
      if (format !== "zip" && path.basename(entry.name) === execName) entry.mode = 0o755
      return entry
    })
    archive.finalize()
  })
}

// Stub Next.js runtime + RSC marker modules — same rationale as build-cli.mjs:
// the CLI reuses lib/claude/*, whose static graph incidentally reaches a few UI
// components that import next/*. The CLI never renders React, so those imports
// must merely RESOLVE (a CJS Proxy no-op), never execute. `react-devtools-core`
// is Ink's optional dev-only devtools integration (imported unconditionally at
// the top of ink/devtools.js but only used when DEV devtools are reachable) —
// stub it so the bundle resolves without pulling in the devtools client.
const STUB_PATTERN = /^(next\/|server-only$|client-only$|react-devtools-core$)/
const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({ path: args.path, namespace: "cli-stub" }))
    build.onLoad({ filter: /.*/, namespace: "cli-stub" }, () => ({
      // `apply: () => noop` so a module-top-level `const C = dynamic(...)`
      // yields a no-op component, not `null` — otherwise `C.displayName`
      // (e.g. markdown-renderer's withRendererErrorBoundary) throws at import.
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

const ASSET_LOADERS = { ".ttf": "empty", ".css": "empty", ".svg": "empty", ".woff": "empty", ".woff2": "empty" }

// Best-effort recursive remove. On Windows a dist subdir can be locked because a
// terminal is parked in it (cwd lock) — that blocks deleting the DIR but not
// rewriting files inside it, so we tolerate the failure and carry on.
function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch (err) {
    console.warn(`build-cli-binary: could not remove ${path.relative(root, p)} (${err.code ?? err.message}) — continuing`)
  }
}

// ESM output: define a real `require` so esbuild's `__require` helper delegates
// to it (it checks `typeof require !== "undefined"`) instead of throwing
// "Dynamic require of X is not supported" for CJS deps that require() builtins.
const CREATE_REQUIRE_BANNER =
  "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"

// 1. CLI → self-contained ESM single file. ESM (not CJS) because the TUI graph
// reaches Ink / yoga-layout, which use top-level await — illegal in CJS output
// but fine in ESM. pkg (@yao-pkg) packages an ESM entry directly.
safeRm(binDir)
fs.mkdirSync(binDir, { recursive: true })
await esbuild.build({
  entryPoints: [cliEntry],
  outfile: cliBundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  tsconfig: path.join(root, "tsconfig.json"),
  banner: { js: CREATE_REQUIRE_BANNER },
  // Inline every npm dep EXCEPT the TUI stack (which breaks when bundled — see
  // TUI_EXTERNALS); those resolve from the adjacent node_modules at runtime.
  external: TUI_EXTERNALS,
  loader: ASSET_LOADERS,
  plugins: [stubNextPlugin],
  logLevel: "info",
})
console.log(`build-cli-binary: wrote ${path.relative(root, cliBundle)}`)

// 1b. Build the adjacent TUI node_modules (react/ink/ink-spinner + closure) via
// a clean npm install — npm produces a flat, portable, self-contained tree,
// avoiding pnpm's symlink/sibling-dep layout. Copied next to cli.mjs per target.
const tuiDepsDir = path.join(binDir, ".tui-deps")
fs.rmSync(tuiDepsDir, { recursive: true, force: true })
fs.mkdirSync(tuiDepsDir, { recursive: true })
fs.writeFileSync(path.join(tuiDepsDir, "package.json"), '{"private":true}\n')
execFileSync(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", ...TUI_DEPS],
  // shell:true so Windows resolves npm's `.cmd` shim (Node >=20 rejects spawning
  // a bare `.cmd` via execFile without it).
  { cwd: tuiDepsDir, stdio: "inherit", shell: true }
)
const tuiNodeModules = path.join(tuiDepsDir, "node_modules")
console.log(`build-cli-binary: built TUI node_modules → ${path.relative(root, tuiNodeModules)}`)

// 2. Sidecar → ESM bundle (heavy/native deps left external).
fs.mkdirSync(sidecarOutDir, { recursive: true })
await esbuild.build({
  entryPoints: [sidecarEntry],
  outfile: path.join(sidecarOutDir, "claude-host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: SIDECAR_EXTERNALS,
  banner: { js: CREATE_REQUIRE_BANNER },
  loader: ASSET_LOADERS,
  logLevel: "info",
})
console.log(`build-cli-binary: wrote ${path.relative(root, path.join(sidecarOutDir, "claude-host.mjs"))}`)

// 2b. Copy the sidecar's runtime-read data files next to the bundle. esbuild
// inlines the JS but NOT files loaded via `fs.readFileSync(import.meta.url-
// relative path)`; in the bundle `import.meta.url` resolves to claude-host.mjs,
// so each such file must sit beside it. store-sqlite.mjs reads `schema.sql` at
// module load (a top-level read — it runs even before the sqlite store is
// constructed), so a missing file crashes the sidecar before it emits `ready`.
const SIDECAR_DATA_FILES = [path.join(root, "sidecar/builtin-tools/code/schema.sql")]
for (const src of SIDECAR_DATA_FILES) {
  if (!fs.existsSync(src)) {
    console.error(`build-cli-binary: missing sidecar data file ${path.relative(root, src)}`)
    process.exit(1)
  }
  fs.cpSync(src, path.join(sidecarOutDir, path.basename(src)))
}
console.log(`build-cli-binary: copied ${SIDECAR_DATA_FILES.length} sidecar data file(s) → ${path.relative(root, sidecarOutDir)}`)

// 3. Copy a pruned node_modules — just the externals (+ their nested deps).
// Under pnpm's isolated layout each package nests its own deps, so a
// dereferenced recursive copy of each external yields a correct closure.
if (!fs.existsSync(sidecarNodeModules)) {
  console.error(
    `build-cli-binary: ${path.relative(root, sidecarNodeModules)} is missing — run \`pnpm sidecar:install\` first.`
  )
  process.exit(1)
}
const destNodeModules = path.join(sidecarOutDir, "node_modules")
// Clean any stale copy (the top-level binDir wipe may have been blocked by a
// cwd lock, leaving prior artifacts behind → cpSync would conflict).
safeRm(destNodeModules)
for (const dep of SIDECAR_EXTERNALS) {
  const src = path.join(sidecarNodeModules, dep)
  if (!fs.existsSync(src)) {
    // node-pty is an optionalDependency — its absence is expected on some hosts.
    console.warn(`build-cli-binary: skipping absent sidecar dep ${dep}`)
    continue
  }
  fs.cpSync(src, path.join(destNodeModules, dep), { recursive: true, dereference: true })
}
console.log(`build-cli-binary: copied sidecar externals → ${path.relative(root, destNodeModules)}`)

// 3b. pkg snapshot entry: a tiny CJS bootstrap. pkg is rock-solid with CJS but
// its ESM-from-snapshot resolution is broken on Windows (it hands Node a raw
// `C:\snapshot\...` path instead of a file:// URL). So we snapshot this CJS,
// which loads the real ESM `cli.mjs` shipped NEXT TO the executable.
fs.writeFileSync(
  pkgBootstrap,
  [
    '"use strict";',
    'const path = require("node:path");',
    'const { pathToFileURL } = require("node:url");',
    'const bundle = path.join(path.dirname(process.execPath), "cli.mjs");',
    "import(pathToFileURL(bundle).href).catch((err) => {",
    '  process.stderr.write(`cognia-agent: failed to load ${bundle}: ${err && err.message ? err.message : err}\\n`);',
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n")
)

// 4 + 5. pkg per target, then assemble the per-platform dist folder.
//
// pkg can only produce a target whose prebuilt Node base binary is available in
// @yao-pkg/pkg-fetch's cache — it cannot cross-compile Node from source for a
// foreign OS. Prebuilt availability varies per platform/version, so a target
// may be unbuildable on a given host (e.g. linux/macos from a Windows machine).
// We therefore build each target independently and skip-with-warning on
// failure, so the host-platform binary is still produced. Build the remaining
// targets on their native CI runners.
const built = []
const skipped = []
for (const t of TARGETS) {
  const distDir = path.join(binDir, t.dist)
  fs.mkdirSync(distDir, { recursive: true })
  const outBin = path.join(distDir, t.bin)
  console.log(`build-cli-binary: pkg → ${t.pkg}`)
  try {
    // pkg FIRST, before touching the support files: if the old binary is locked
    // (e.g. it's running), pkg fails here and the previous complete folder is
    // left intact rather than half-deleted.
    safeRm(outBin)
    // `--no-bytecode --public`: skip V8 bytecode compilation (which OOMs on the
    // ~70MB bundle and is pointless here — we don't need source protection) and
    // embed the plain JS instead.
    await pkg.exec([
      pkgBootstrap,
      "--targets",
      t.pkg,
      "--output",
      outBin,
      "--no-bytecode",
      "--public",
      "--public-packages",
      "*",
    ])
    // The binary wrote successfully — now refresh the support files next to it.
    // The CJS snapshot entry imports cli.mjs from here, and cli.mjs resolves
    // react/ink from the adjacent node_modules at runtime.
    for (const child of ["cli.mjs", "node_modules", "sidecar"]) safeRm(path.join(distDir, child))
    fs.cpSync(cliBundle, path.join(distDir, "cli.mjs"))
    fs.cpSync(tuiNodeModules, path.join(distDir, "node_modules"), {
      recursive: true,
      dereference: true,
    })
    fs.cpSync(sidecarOutDir, path.join(distDir, "sidecar"), { recursive: true, dereference: true })
    console.log(`build-cli-binary: assembled ${path.relative(root, distDir)}`)

    // Compress the assembled folder into a shareable per-platform archive.
    const archiveExt = t.archive === "zip" ? ".zip" : ".tar.gz"
    const archiveFile = path.join(binDir, t.dist + archiveExt)
    safeRm(archiveFile)
    const bytes = await makeArchive(distDir, t.archive, archiveFile, t.bin)
    console.log(
      `build-cli-binary: archived ${path.relative(root, archiveFile)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`
    )
    built.push(t.pkg)
  } catch (err) {
    safeRm(distDir)
    console.warn(
      `build-cli-binary: SKIPPED ${t.pkg} — ${err?.message ?? err}\n` +
        `  (no prebuilt Node base for this target on this host; build it on a native ${t.pkg} runner)`
    )
    skipped.push(t.pkg)
  }
}

console.log(`build-cli-binary: done — built [${built.join(", ")}]` + (skipped.length ? `, skipped [${skipped.join(", ")}]` : ""))
if (built.length === 0) {
  console.error("build-cli-binary: no targets produced a binary")
  process.exit(1)
}
