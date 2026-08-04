import { execSync } from "node:child_process"
import path from "node:path"

import createNextIntlPlugin from "next-intl/plugin"
import withSerwistInit from "@serwist/next"
import type { NextConfig } from "next"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const isProd = process.env.NODE_ENV === "production"

// Build-time metadata surfaced on the About page (components/settings/about/*).
// Resolved here in Node at config-eval time and inlined into the client bundle
// as `process.env.NEXT_PUBLIC_*`. Both reads are failure-tolerant: a tarball /
// CI checkout without git, or a frozen clock, must never break the build.
const gitCommit = (() => {
  if (process.env.NEXT_PUBLIC_GIT_COMMIT) return process.env.NEXT_PUBLIC_GIT_COMMIT
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return ""
  }
})()
const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME || new Date().toISOString()

// Wave 4 / ADR-0026 — Serwist PWA.
//
// Enabled on web + Tauri builds; disabled on Capacitor mobile because the
// iOS WKWebView serves content from the `capacitor://localhost` custom
// scheme, which standard ServiceWorker registration rejects. The mobile
// shell relies on the Dexie-first SyncOrchestrator (lib/sync/companion-sync.ts)
// for offline tolerance instead — no SW required.
//
// Also disabled in development so HMR works without precache stale-while-revalidate
// interference.
const disableSerwist =
  process.env.NEXT_PUBLIC_PLATFORM === "mobile" || process.env.NODE_ENV !== "production"
const MAX_PRECACHE_ASSET_BYTES = 2 * 1024 * 1024

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  reloadOnOnline: true,
  disable: disableSerwist,
  // Large optional runtimes (Transformers.js WASM and its lazy worker chunk)
  // must remain network-on-demand. Filtering them explicitly preserves the
  // default 2 MiB precache budget without emitting a warning for every build.
  maximumFileSizeToCacheInBytes: MAX_PRECACHE_ASSET_BYTES,
  exclude: [({ asset }) => asset.source.size() > MAX_PRECACHE_ASSET_BYTES],
})

const internalHost = process.env.TAURI_DEV_HOST

// Relative path: Turbopack on Windows rejects absolute paths in resolveAlias.
const browserStub = "./lib/browser-stubs/empty.js"
const browserStubAbs = path.resolve(process.cwd(), "lib/browser-stubs/empty.js")

// `os` is the one Node built-in that gets a non-empty browser stub. Unlike the
// rest of NODE_ONLY_MODULES (read by nobody in the browser), some third-party
// deps call `os` at *module eval* — notably `@vercel/oidc` (dragged in by `ai`
// → `@ai-sdk/gateway`) computes a User-Agent constant from `os.platform()` /
// `os.arch()` / `os.hostname()`. Against the empty `{}` stub those throw
// `TypeError: os.platform is not a function` and crash any bundle that merely
// evaluates a module importing `"ai"`. The shim returns inert browser values.
const osShimStubRel = "./lib/browser-stubs/os-shim.js"
const osShimStubAbs = path.resolve(process.cwd(), "lib/browser-stubs/os-shim.js")

// pixi.js's package entry (`lib/index.mjs`) is an un-bundled barrel that
// re-exports from hundreds of `lib/**` source modules. The Live2D pet pulls the
// whole graph in (the canvas `import("pixi.js")`s it and
// `untitled-pixi-live2d-engine` imports it as a peer), and compiling those
// hundreds of modules on-demand overwhelms the dev compiler — under Turbopack
// with the 4 GB dev heap it never settles, so selecting the Live2D skin spins
// "compiling" forever (and can OOM the dev server outright). pixi ships a
// pre-bundled, fully self-contained single-file ESM (`dist/pixi.mjs`, no inner
// imports) exporting the same surface; aliasing to it collapses pixi to ONE
// module for both bundlers. Both importers (our canvas + the engine) resolve to
// the same file, so there is still exactly one pixi instance.
//
// The alias MUST target a filesystem path, not the package subpath
// `pixi.js/dist/pixi.mjs`: pixi's `exports` map only lists `.` and a few init
// entries, so a bare subpath is rejected (ERR_PACKAGE_PATH_NOT_EXPORTED). A
// filesystem path bypasses `exports`. Turbopack rejects absolute paths in
// `resolveAlias` on Windows (same reason `browserStub` is relative), so dev
// uses a repo-relative path; webpack wants an absolute one.
const PIXI_PREBUNDLED_REL = "./node_modules/pixi.js/dist/pixi.mjs"
const PIXI_PREBUNDLED_ABS = path.resolve(process.cwd(), "node_modules/pixi.js/dist/pixi.mjs")

// `@huggingface/transformers` exports a Node build whenever webpack evaluates
// the worker import from the server compilation. That build pulls native
// `onnxruntime-node` binaries into the static export and webpack tries to parse
// every platform's `.node` file as JavaScript. This package is browser-only by
// contract, so pin its worker dependency to the web export in every webpack
// compilation context.
const TRANSFORMERS_WEB_ABS = path.resolve(
  process.cwd(),
  "packages/transformers-runtime/node_modules/@huggingface/transformers/dist/transformers.web.js"
)

// Node.js built-ins that third-party deps reach for. Our first-party code no
// longer touches any of these (the two surviving Node-leaning modules,
// `lib/twin/importers/code-repo/git-repo.ts` and `lib/github/workspace.ts`,
// now invoke Tauri Rust commands instead of `simple-git` / `node:fs/promises`),
// so the previous `SERVER_ONLY_PACKAGES = ["simple-git"]` entry is gone for
// good. The list below still exists because the Next.js bundle pulls in
// third-party libraries we don't control whose transitive deps reach for
// Node built-ins — e.g. `@modelcontextprotocol/sdk/client/stdio` (workflow
// MCP node) hops through `cross-spawn` → `which` → `isexe/windows.js`, which
// statically requires `fs` and `child_process`. The MCP node only ever runs
// in the Tauri main process, but webpack still has to resolve the dynamic
// chunk targets, so we substitute an empty stub for the client bundle.
//
// Both bare (`fs`) and `node:`-prefixed (`node:fs`) forms must be listed:
// Turbopack matches `resolveAlias` keys against the literal request string
// and does NOT strip the `node:` protocol, so `import "node:fs/promises"`
// bypasses an alias keyed only on `"fs/promises"`.
const NODE_ONLY_MODULES = [
  "dns",
  "node:dns",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "http2",
  "node:http2",
  "stream/promises",
  "node:stream/promises",
  // Webpack 5 with Next.js 16 doesn't auto-polyfill `node:events` for
  // ESM deps that import it explicitly. Aliasing to the stub keeps the
  // mobile bundle from blowing up the moment any transitive dep
  // (cross-spawn → ... → events, etc.) reaches for it.
  "events",
  "node:events",
  // First-party node-only helper that is statically reachable from the client
  // module graph but only ever executes in the Node sidecar / Tauri main
  // process — never in the WebView: `lib/skills/built-in/lark/exec-lark-cli`
  // spawns the lark-cli binary and pulls in `util`/`os`/`path` alongside the
  // already-listed `child_process`/`fs`. Webpack tolerates the omission via its
  // default client fallbacks, but Turbopack's `resolveAlias` only stubs modules
  // named here, so all three must be listed for the dev bundle to stay clean.
  "util",
  "node:util",
  "os",
  "node:os",
  "path",
  "node:path",
]

// Enable static export for Tauri production builds.
// This makes `pnpm build` generate the `out/` directory that Tauri loads from `src-tauri/tauri.conf.json` (frontendDist: "../out").
// In dev, leave `output` undefined so Next.js 16's strict static-export checks
// don't reject runtime navigation to dynamic routes whose params aren't pre-listed
// (see vercel/next.js#56477). Production export behavior is unchanged.
const nextConfig: NextConfig = {
  output: isProd ? "export" : undefined,
  // AI SDK 7 is ESM-only (`"type": "module"`, no CJS dist). Listing the packages
  // here is what lets `next/jest` transform them under Jest's CommonJS runtime:
  // next/jest PREPENDS its own `transformIgnorePatterns` built from this list,
  // and its `.pnpm` rule excludes every virtual-store path that isn't named
  // here — so a hand-written entry in `jest.config.ts` can never win (patterns
  // are OR'd, and next/jest's rule matches first). `ai` really does reach the
  // browser bundle via the standalone/BYOK chat engine, so transpiling it is
  // correct for the static export too, not a test-only concession.
  transpilePackages: [
    "@agentclientprotocol/sdk",
    "ai",
    "@ai-sdk/alibaba",
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/anthropic",
    "@ai-sdk/azure",
    "@ai-sdk/bytedance",
    "@ai-sdk/cohere",
    "@ai-sdk/deepinfra",
    // Not a direct dependency — pulled in transitively, and ESM-only like the
    // rest. Every installed `@ai-sdk/*` is listed here on purpose: next/jest
    // matches exact package names, so one missing entry fails the whole suite.
    "@ai-sdk/deepseek",
    "@ai-sdk/fal",
    "@ai-sdk/fireworks",
    "@ai-sdk/gateway",
    "@ai-sdk/google",
    "@ai-sdk/mcp",
    "@ai-sdk/mistral",
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/provider",
    "@ai-sdk/provider-utils",
    "@ai-sdk/react",
    "@ai-sdk/replicate",
    "@ai-sdk/togetherai",
    "@ai-sdk/xai",
    // ESM-only transitive deps of `@ai-sdk/provider-utils@5`. next/jest builds
    // its allowlist from exact package names, so a transitive dep the SDK pulls
    // in has to be named too or the CJS runtime trips on its `export` keyword.
    "@standard-schema/spec",
    "@workflow/serde",
  ],
  // Tauri and local browser tooling may address the same dev server through
  // the IPv4 loopback alias while Next starts it as `localhost`. Allow only
  // that additional loopback host so HMR and generated font resources remain
  // available without widening dev-resource access to the LAN.
  allowedDevOrigins: ["127.0.0.1"],
  // Build-time type checking uses a stories-free program. Storybook
  // `*.stories.tsx` and their `lib/storybook/**` fixtures are dev-only preview
  // artifacts that never enter the static export, so a broken story must not
  // fail the production build. `pnpm typecheck` still uses the root tsconfig and
  // type-checks stories. See `tsconfig.build.json`.
  //
  // ADR-0068 C1 — `ignoreBuildErrors` skips the in-build tsc pass entirely.
  // `next build` used to full-check the ~9k-file program cold on every build,
  // duplicating the `pnpm typecheck` gate that CI's quality job and the local
  // workflow already run. SWC does the actual compilation either way, so this
  // changes build time only, never the emitted `out/` that Tauri and
  // Capacitor consume. The type gate stays enforced by
  // `.github/workflows/quality.yml` → `pnpm typecheck`.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
    ignoreBuildErrors: true,
  },
  // Barrel-import optimization. These packages re-export hundreds of symbols
  // from a single entry; without this, both Turbopack (dev) and webpack
  // (build) pull the whole barrel into every importer's module graph. Given
  // `motion` (75 files), `radix-ui` (34) and `recharts` (17) are imported
  // across the app — and the root layout transitively reaches most of them —
  // rewriting `import { X } from "pkg"` to the concrete submodule sharply cuts
  // the dev compile graph (a primary driver of dev-server memory) without any
  // runtime/output change, so it is safe for the static-export bundle that
  // both Tauri and Capacitor consume. `lucide-react`/`date-fns` are already in
  // Next's built-in default list, so they are intentionally omitted here.
  experimental: {
    optimizePackageImports: ["radix-ui", "motion", "recharts"],
    // Disable Turbopack's persistent FileSystem dev cache (default-on since
    // Next 16.1). Its LSM store (`.next/dev/cache/turbopack/`) has an upstream
    // single-writer race where a background compaction and a persist write
    // batch collide, spamming `Persisting failed: Another write batch or
    // compaction is already active` / `Compaction failed: ...` and often
    // corrupting the `.sst` files (vercel/next.js#90691). The store is compiled
    // into the SWC binary and can't be patched here. Turning it off removes the
    // race entirely and also defuses the unbounded cache-growth/OOM problems
    // this repo has fought before; the trade-off is slower cold starts (no
    // cross-session cache restore), which also makes the predev
    // `clean-stale-turbopack-cache.mjs` purge largely redundant for dev.
    // turbopackFileSystemCacheForDev: false,
  },
  // Build-time metadata for the About page. Inlined as NEXT_PUBLIC_* envs.
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommit,
    NEXT_PUBLIC_BUILD_TIME: buildTime,
  },
  // Note: This feature is required to use the Next.js Image component in SSG mode.
  // See https://nextjs.org/docs/messages/export-image-api for different workarounds.
  images: {
    unoptimized: true,
  },
  // Ordinary browser development must keep lazy chunks on the page origin so
  // `next dev --port <port>` continues to work when 3000 is unavailable.
  // Tauri sets TAURI_DEV_HOST when its WebView needs an explicit cross-origin
  // asset host; preserve that path without forcing every dev session to :3000.
  assetPrefix: !isProd && internalHost ? `http://${internalHost}:3000` : undefined,
  // Turbopack (pnpm dev): alias Node.js built-ins to the empty stub so none of
  // their (third-party) callers enter the browser bundle.
  turbopack: {
    // Pin the workspace root to this project. Without it, Next.js infers the
    // root by walking up for lockfiles and picks the stray
    // `/Users/bytedance/Project/package-lock.json` over our own
    // `pnpm-workspace.yaml`, emitting a "multiple lockfiles" warning and
    // potentially resolving modules from the wrong tree.
    root: __dirname,
    resolveAlias: {
      // `{ browser: … }` conditional form, NOT a bare string: unlike the
      // webpack branch below (gated on `!isServer`), Turbopack applies
      // `resolveAlias` to EVERY compile context — including the app-rsc
      // server bundle, where Next's own `shared/lib/isomorphic/path.js` →
      // `lib/metadata/get-metadata-route.js` needs the real `path` on every
      // route render (`path.parse` on the empty stub crashed `/` in dev).
      // The condition scopes the stubs to the browser bundle only.
      ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, { browser: browserStub }])),
      // `os` gets the non-empty shim instead of the empty stub (see above). The
      // spread above already mapped both forms; these keys win.
      os: { browser: osShimStubRel },
      "node:os": { browser: osShimStubRel },
      // Collapse pixi.js to its pre-bundled single file (see above). Applies
      // in every context on purpose — the barrel is the problem everywhere.
      "pixi.js": PIXI_PREBUNDLED_REL,
    },
  },
  // Webpack (pnpm build): client-side fallbacks for Node built-ins.
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, false])),
        // `os` resolves to the non-empty shim on the client, not the empty
        // `false` fallback: deps like `@vercel/oidc` (via `ai`) probe it at
        // eval and would otherwise crash the WebView/Capacitor bundle. The
        // server keeps the real Node `os` (this branch is client-only).
        os: osShimStubAbs,
        "node:os": osShimStubAbs,
      }
      // Webpack's fallback table only handles ordinary package requests; the
      // `node:` URI scheme is rejected earlier by its module reader. Replace
      // those browser-incompatible requests before resolution, matching the
      // Turbopack aliases above.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request === "node:os" ? osShimStubAbs : browserStubAbs
        })
      )
    }
    // Same pixi collapse for the production export consumed by Tauri/Capacitor,
    // so the Live2D lazy chunk pulls one pre-bundled file instead of the barrel.
    config.resolve.alias = {
      ...config.resolve.alias,
      "pixi.js$": PIXI_PREBUNDLED_ABS,
      "@huggingface/transformers$": TRANSFORMERS_WEB_ABS,
    }
    return config
  },
}

export default withNextIntl(withSerwist(nextConfig))
