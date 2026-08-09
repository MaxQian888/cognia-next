/**
 * Bundle `@cognia/agent` into a publishable ESM package.
 *
 * Strategy: identical to `build-cli.mjs` — esbuild resolves the `@/*` graph
 * from the root tsconfig, inlines everything reachable, and the published
 * bundle contains zero `@/` specifiers. Browser-only, React-only, and Next.js
 * modules are stubbed (the SDK is a headless Node library; it never renders).
 *
 * Usage: node scripts/build/build-agent-sdk.mjs
 */

import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import { createCliExternalAgentAliasPlugin } from "./cli-external-agent-aliases.mjs"

const root = path.dirname(fileURLToPath(import.meta.url)) + "/../.."
const entry = path.join(root, "packages/agent/src/index.ts")
const outdir = path.join(root, "packages/agent/dist")

let esbuild
try {
  esbuild = await import("esbuild")
} catch {
  console.error("build-agent-sdk: esbuild is not installed. Run: pnpm add -D esbuild")
  process.exit(1)
}

// Stub Next.js / React / browser-only modules — same approach as build-cli.mjs
const STUB_PATTERN = /^(next\/|server-only$|client-only$|react$|react-dom|react\/)/
const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({
      path: args.path,
      namespace: "sdk-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "sdk-stub" }, () => ({
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

// JSON default-only loader for i18n messages (same as CLI build)
const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n\/messages\/.*\.json$/ }, (args) => {
      const data = fs.readFileSync(args.path, "utf8")
      return {
        contents: `export default ${data}`,
        loader: "js",
      }
    })
  },
}

// Clean the output directory
if (fs.existsSync(outdir)) {
  fs.rmSync(outdir, { recursive: true })
}
fs.mkdirSync(outdir, { recursive: true })

await esbuild.build({
  entryPoints: [entry],
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  splitting: false,
  sourcemap: true,
  minify: false,
  packages: "external",
  // Externalize native add-ons and optional runtime deps that a consuming
  // project can provide (or not). The SDK re-exports types from
  // @cognia/agent-config-types, which is itself bundled (source-only package).
  external: [
    "better-sqlite3",
    "onnxruntime-node",
  ],
  alias: {
    "@/": root + "/",
  },
  plugins: [
    createCliExternalAgentAliasPlugin(root),
    stubNextPlugin,
    jsonDefaultOnlyPlugin,
  ],
  logLevel: "info",
})

// Generate a minimal type declaration that re-exports from the source. The real
// `.d.ts` generation is done by tsc separately (or by the consumer's bundler).
const dtsContent = `export * from "../src/index";\n`
fs.writeFileSync(path.join(outdir, "index.d.ts"), dtsContent)

console.log("✓ @cognia/agent built to packages/agent/dist/")
