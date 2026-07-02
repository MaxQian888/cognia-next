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

const root = path.dirname(fileURLToPath(import.meta.url)) + "/../.."
const entry = path.join(root, "cli/src/cli/entry.ts")
const outdir = path.join(root, "cli/dist")

let esbuild
try {
  esbuild = await import("esbuild")
} catch {
  console.error("build-cli: esbuild is not installed. Run: pnpm add -D esbuild")
  process.exit(1)
}

// Stub Next.js runtime + RSC marker modules. The CLI reuses lib/claude/*, whose
// static graph incidentally reaches a few UI components that import next/image,
// next/dynamic, etc. The CLI never renders React, so those imports must merely
// RESOLVE (not execute). A CJS Proxy stub satisfies BOTH a default import and
// any named import (`import { useRouter } from "next/navigation"`) — every
// access yields a no-op, which is never called on the agent's code paths.
const STUB_PATTERN = /^(next\/|server-only$|client-only$)/
const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({
      path: args.path,
      namespace: "cli-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "cli-stub" }, () => ({
      // `__esModule: true` so esbuild's interop uses the module as-is; every
      // other access (default, or any named export) yields a callable no-op,
      // so module-top-level uses like `dynamic(() => import(...))` don't throw.
      // `__esModule` MUST be falsy: esbuild's __toESM then sets `default` to the
      // whole (callable) proxy, so a default import like next/dynamic stays
      // callable. Any named export resolves to the same no-op.
      //
      // The `apply` trap MUST return the callable `noop`, NOT its result: a
      // module-top-level `const C = dynamic(() => import(...))` then does
      // `C.displayName` / renders `<C/>`. If calling the stub returned `null`
      // (the target's return value), `C` is null and `C.displayName` throws
      // "Cannot read properties of null". Returning `noop` makes `C` a no-op
      // component whose props access is harmless.
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

// Load the i18n aggregate messages as DEFAULT-ONLY JSON modules. esbuild's
// json loader also emits a named export per top-level key, and the messages
// contain an `eval` namespace — `var eval = ...` is a SyntaxError in the
// strict-mode ESM chunk, which crashed `cognia-agent serve` at the runtimes
// import (ADR-0059 T-B3 hand-run). Default-only sidesteps the reserved names.
const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n[\\/]messages[\\/][^\\/]+\.json$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises")
      const raw = await readFile(args.path, "utf8")
      return { contents: `export default ${raw}`, loader: "js" }
    })
  },
}

await esbuild.build({
  entryPoints: [entry],
  outdir,
  entryNames: "cognia-agent",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  tsconfig: path.join(root, "tsconfig.json"),
  banner: { js: "#!/usr/bin/env node" },
  // Code-splitting: dynamic `import()` chains (the desktop option-builder pulls
  // many, some reaching browser-only UI) become lazy chunks loaded only when
  // their code path runs. The entry chunk eagerly imports just what the
  // synchronous command path needs, so `--help` / `config` / a headless `run`
  // never touch the browser-only graph.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  // npm deps stay external runtime imports (resolved from node_modules) — keeps
  // the bundle small and browser-only packages out of the eager graph.
  packages: "external",
  // Drop any statically-imported assets rather than fail the build.
  loader: {
    ".ttf": "empty",
    ".css": "empty",
    ".svg": "empty",
    ".woff": "empty",
    ".woff2": "empty",
  },
  plugins: [stubNextPlugin, jsonDefaultOnlyPlugin],
  logLevel: "info",
})

console.log(`build-cli: wrote ${path.relative(root, outdir)}/cognia-agent.js`)
