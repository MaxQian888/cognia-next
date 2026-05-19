import createNextIntlPlugin from "next-intl/plugin"
import withSerwistInit from "@serwist/next"
import type { NextConfig } from "next"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const isProd = process.env.NODE_ENV === "production"

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
    resolveAlias: Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, browserStub])),
  },
  // Webpack (pnpm build): client-side fallbacks for Node built-ins.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, false])),
      }
    }
    return config
  },
}

export default withNextIntl(withSerwist(nextConfig))
