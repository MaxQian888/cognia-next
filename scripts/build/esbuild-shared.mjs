// One esbuild pipeline for every Node entry that reuses the app's TS graph:
// the `cognia-agent` CLI bundle (build-cli.mjs), the PTY test fixture
// (bundle-tui-fixture.mjs), and whatever entry comes next. The plugin list
// and the option set live here so the fixture is bundled EXACTLY the way the
// shipped binary is. That is the point: esbuild folds the whole graph into
// one scope, so the CJS/ESM boundary shims (`types/ocr/index.ts` re-exporting
// `@cognia/ocr/types`, …) never reach cjs-module-lexer. Running the same
// sources through `tsx` does not fold them, which is why a from-source run can
// crash with "does not provide an export named …" while the bundle works.
// See scripts/build/dev-cli.mjs for the history.

import path from "node:path"
import { createCliExternalAgentAliasPlugin } from "./cli-external-agent-aliases.mjs"

// Stub Next.js runtime + RSC marker modules. The CLI reuses lib/claude/*, whose
// static graph incidentally reaches a few UI components that import next/image,
// next/dynamic, etc. The CLI never renders React, so those imports must merely
// RESOLVE (not execute). A CJS Proxy stub satisfies BOTH a default import and
// any named import (`import { useRouter } from "next/navigation"`) — every
// access yields a no-op, which is never called on the agent's code paths.
const STUB_PATTERN = /^(next\/|server-only$|client-only$)/
export const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({
      path: args.path,
      namespace: "cli-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "cli-stub" }, () => ({
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
export const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n[\\/]messages[\\/][^\\/]+\.json$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises")
      const raw = await readFile(args.path, "utf8")
      return { contents: `export default ${raw}`, loader: "js" }
    })
  },
}

// The RPC protocol is imported from the standalone @cognia/agent source so the
// client and host share one schema map. Unlike the app's ordinary npm runtime
// dependencies, its validator belongs to the host wire contract and must remain
// available after the CLI bundle is copied into a platform host package.
export function createBundleAgentProtocolDependenciesPlugin(root) {
  return {
    name: "bundle-agent-protocol-dependencies",
    setup(build) {
      build.onResolve({ filter: /^valibot$/ }, () => ({
        path: path.join(root, "packages/agent/node_modules/valibot/dist/index.mjs"),
      }))
    },
  }
}

/** The plugin list, in the order the CLI bundle has always used. */
export function createCliEsbuildPlugins(root) {
  return [
    createCliExternalAgentAliasPlugin(root),
    createBundleAgentProtocolDependenciesPlugin(root),
    stubNextPlugin,
    jsonDefaultOnlyPlugin,
  ]
}

/**
 * The shared esbuild option set. `entry`, `outdir` and `entryNames` vary per
 * caller; everything else is the shipped CLI's configuration.
 */
export function cliEsbuildOptions({ root, entry, outdir, entryNames, banner = true }) {
  return {
    entryPoints: [entry],
    outdir,
    entryNames,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    tsconfig: path.join(root, "tsconfig.json"),
    ...(banner ? { banner: { js: "#!/usr/bin/env node" } } : {}),
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
    plugins: createCliEsbuildPlugins(root),
    logLevel: "info",
  }
}

export async function loadEsbuild() {
  try {
    return await import("esbuild")
  } catch {
    console.error("esbuild is not installed. Run: pnpm add -D esbuild")
    process.exit(1)
  }
}
