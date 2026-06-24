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

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  reloadOnOnline: true,
  disable: disableSerwist,
})

const internalHost = process.env.TAURI_DEV_HOST || "localhost"

// Relative path: Turbopack on Windows rejects absolute paths in resolveAlias.
const browserStub = "./lib/browser-stubs/empty.js"

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
]

// Enable static export for Tauri production builds.
// This makes `pnpm build` generate the `out/` directory that Tauri loads from `src-tauri/tauri.conf.json` (frontendDist: "../out").
// In dev, leave `output` undefined so Next.js 16's strict static-export checks
// don't reject runtime navigation to dynamic routes whose params aren't pre-listed
// (see vercel/next.js#56477). Production export behavior is unchanged.
const nextConfig: NextConfig = {
  output: isProd ? "export" : undefined,
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
    turbopackFileSystemCacheForDev: false,
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
  // Configure assetPrefix or else the server won't properly resolve your assets.
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
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
      ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, browserStub])),
      // Collapse pixi.js to its pre-bundled single file (see above).
      "pixi.js": PIXI_PREBUNDLED_REL,
    },
  },
  // Webpack (pnpm build): client-side fallbacks for Node built-ins.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, false])),
      }
    }
    // Same pixi collapse for the production export consumed by Tauri/Capacitor,
    // so the Live2D lazy chunk pulls one pre-bundled file instead of the barrel.
    config.resolve.alias = {
      ...config.resolve.alias,
      "pixi.js$": PIXI_PREBUNDLED_ABS,
    }
    return config
  },
}

export default withNextIntl(withSerwist(nextConfig))
