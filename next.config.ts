import createNextIntlPlugin from "next-intl/plugin"
import path from "node:path"
import type { NextConfig } from "next"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const isProd = process.env.NODE_ENV === "production"

const internalHost = process.env.TAURI_DEV_HOST || "localhost"

// Relative path: Turbopack on Windows rejects absolute paths in resolveAlias.
const browserStub = "./lib/browser-stubs/empty.js"

// Vector DB SDKs and their transitive server-only dependencies. All four
// backend client files (pinecone-client, qdrant-client, chroma-client,
// milvus-client) import these statically, so they must be aliased to an empty
// stub before the browser bundler resolves them.
const SERVER_ONLY_PACKAGES = [
  // Vector DB SDKs
  "@pinecone-database/pinecone",
  "@qdrant/js-client-rest",
  "chromadb",
  "@zilliz/milvus2-sdk-node",
  // gRPC / Parquet transitive deps of milvus2-sdk-node
  "@grpc/grpc-js",
  "@dsnp/parquetjs",
  "thrift",
  "node-int64",
  // simple-git shells out — only the Tauri code-repo importer uses it,
  // alias to the empty stub so the mobile / web bundle stays clean.
  "simple-git",
]

// Truly un-polyfillable Node.js built-ins (safety net for any dep that slips
// past the package-level alias above). Do NOT include modules that Turbopack/
// webpack polyfill automatically (path, stream, os, zlib).
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
  // (simple-git → @kwsites/file-exists, etc.) reaches for it.
  "events",
  "node:events",
]

// Enable static export for Tauri production builds.
// This makes `pnpm build` generate the `out/` directory that Tauri loads from `src-tauri/tauri.conf.json` (frontendDist: "../out").
const nextConfig: NextConfig = {
  output: "export",
  // Note: This feature is required to use the Next.js Image component in SSG mode.
  // See https://nextjs.org/docs/messages/export-image-api for different workarounds.
  images: {
    unoptimized: true,
  },
  // Configure assetPrefix or else the server won't properly resolve your assets.
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  // Prevent these packages from being server-bundled (loaded via require() at runtime).
  serverExternalPackages: [
    "@zilliz/milvus2-sdk-node",
    "@grpc/grpc-js",
    "@pinecone-database/pinecone",
    "@qdrant/js-client-rest",
    "chromadb",
  ],
  // Turbopack (pnpm dev): alias server-only packages + Node.js built-ins to the
  // empty stub so none of their transitive deps enter the browser bundle.
  turbopack: {
    resolveAlias: {
      ...Object.fromEntries(SERVER_ONLY_PACKAGES.map((pkg) => [pkg, browserStub])),
      ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, browserStub])),
    },
  },
  // Webpack (pnpm build): package-level aliases + built-in fallbacks for client bundles.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Webpack aliases must be absolute paths (relative ones get treated
      // as module IDs and never resolve). Turbopack accepts the relative
      // form, so we keep `browserStub` as a relative literal and resolve
      // here.
      const stubAbsolute = path.resolve(process.cwd(), browserStub)
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(SERVER_ONLY_PACKAGES.map((pkg) => [pkg, stubAbsolute])),
      }
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...Object.fromEntries(NODE_ONLY_MODULES.map((m) => [m, false])),
      }
    }
    return config
  },
}

export default withNextIntl(nextConfig)
