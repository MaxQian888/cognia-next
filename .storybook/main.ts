import path from "node:path"
import type { StorybookConfig } from "@storybook/nextjs"

// Storybook runs on the WEBPACK framework (`@storybook/nextjs`) — the same
// bundler as the real Next app — not the Vite/rolldown framework. Rationale:
// rolldown evaluates several transitive deps' module-init out of order when the
// heavy chat graph is bundled into one story chunk ("createRegistry /
// createSelectorCreator is not defined" from tokenlens/reselect/plugin
// registries), which blocks full-page stories like ChatPane. Webpack resolves
// those exactly like `pnpm build` does, so no per-dep stubbing is needed.
//
// The webpack framework reads next.config.ts's basics but NOT its custom
// `webpack()` resolve customizations, so we mirror the two that matter for a
// browser bundle: Node-only built-ins → false, and the pixi single-file
// collapse. The only story-specific mock is the LLM-backed follow-ups hook.

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
  "events",
  "node:events",
]

// Optional server-only deps loaded via `import(/* webpackIgnore */ "pkg")`.
const OPTIONAL_SERVER_PACKAGES = ["langfuse"]

const PIXI_PREBUNDLED_ABS = path.resolve(process.cwd(), "node_modules/pixi.js/dist/pixi.mjs")
const FOLLOW_UPS_MOCK = path.resolve(process.cwd(), "hooks/chat/use-follow-up-suggestions.mock.ts")

const config: StorybookConfig = {
  framework: {
    name: "@storybook/nextjs",
    options: {
      builder: {
        // Persistent webpack cache in node_modules/.cache/webpack — turns the
        // ~50s cold compile into a warm-start of a few seconds.
        fsCache: true,
        // Compile stories on demand (dev only). With 1200+ story files the
        // eager preview bundle pulls in effectively the whole app; lazy
        // compilation makes startup compile just the preview shell and pays
        // for each story the first time it is opened.
        lazyCompilation: true,
      },
    },
  },
  // addon-mcp serves the local Storybook AI MCP at http://localhost:6006/mcp
  // while `pnpm storybook` is running (registered in .mcp.json).
  addons: ["@storybook/addon-docs", "@storybook/addon-mcp"],
  // Co-located stories. Pilot is limited to components/ (not app/hooks/lib).
  stories: ["../components/**/*.stories.@(tsx|ts)"],
  // Serve `public/` at the root like Next does, so stories that reference
  // static assets by absolute path (`/icons/icon-512.png` in the mobile boot
  // screen, brand marks, fixtures) render them instead of a broken image.
  staticDirs: ["../public"],
  // react-docgen recurses infinitely on some store modules pulled into the
  // graph (e.g. lib/platform/viewport-store.ts); preview doesn't need prop tables.
  typescript: { reactDocgen: false },
  webpackFinal: async (cfg) => {
    // `storybook dev` crashes in webpack's watcher after a compile:
    // `FileSystemInfo._resolveContextTimestamp` hashes a snapshotted directory
    // (context) whose nested-symlink entry resolves to an `undefined`
    // timestampHash, throwing "Cannot read properties of undefined (reading
    // 'length')" (webpack-5 bug aggravated by pnpm symlinks, see
    // webpack/discussions#17373). The offending contexts are the pnpm
    // *workspace package* directories (`packages/*`, `mobile`, `docs`,
    // `plugin-sdk/*`) that `resolve.symlinks` realpaths out of node_modules,
    // so ignoring node_modules alone only fixed the first-compile crash — the
    // first *re*build still died. Fix: watch-ignore every directory Storybook
    // doesn't serve stories from (anchored at the repo root so e.g.
    // `components/mobile/` stays watched). Tradeoff: edits under packages/*
    // need a Storybook restart to show up.
    const IGNORED_ROOT_DIRS = [
      "node_modules",
      "packages",
      "mobile",
      "docs",
      "plugin-sdk",
      "sidecar",
      "services",
      "src-tauri",
      "cli",
      "out",
      "\\.next",
      "\\.git",
    ]
    const escapedRoot = process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    cfg.watchOptions = {
      ...(cfg.watchOptions ?? {}),
      ignored: new RegExp(
        `(^${escapedRoot}[\\\\/](${IGNORED_ROOT_DIRS.join("|")})[\\\\/])|([\\\\/]node_modules[\\\\/])`
      ),
    }

    // Disable React Fast Refresh. Its `registerExportsForReactRefresh` eagerly
    // reads each module's default export during init; a benign circular import
    // in the chat graph (`stores/artifact` ↔ `lib/plugin/messaging/hooks-system`)
    // then throws "Cannot access '__WEBPACK_DEFAULT_EXPORT__' before
    // initialization" — DEV ONLY (the production `storybook build` has no refresh
    // and renders fine). We trade HMR for a full reload on edit, which Storybook
    // handles cleanly. Strip both halves: the runtime plugin and the loaders'
    // refresh injection (else `$RefreshReg$` is undefined).
    cfg.plugins = (cfg.plugins ?? []).filter(
      (p) =>
        !/ReactRefresh/.test((p as { constructor?: { name?: string } })?.constructor?.name ?? "")
    )
    const stripRefresh = (use: unknown) => {
      for (const u of Array.isArray(use) ? use : [use]) {
        const opts = (u as { options?: Record<string, unknown> })?.options
        if (opts && typeof opts === "object") {
          if ("hasReactRefresh" in opts) opts.hasReactRefresh = false
          if (Array.isArray(opts.plugins)) {
            opts.plugins = opts.plugins.filter(
              (pl) => !String(Array.isArray(pl) ? pl[0] : pl).includes("react-refresh")
            )
          }
        }
      }
    }
    const walkRules = (rules: unknown[] | undefined) => {
      for (const r of rules ?? []) {
        const rule = r as { use?: unknown; oneOf?: unknown[]; rules?: unknown[] }
        if (!rule || typeof rule !== "object") continue
        if (rule.use) stripRefresh(rule.use)
        if (rule.oneOf) walkRules(rule.oneOf)
        if (rule.rules) walkRules(rule.rules)
      }
    }
    walkRules(cfg.module?.rules as unknown[] | undefined)

    // Memory/disk bounds for the fsCache enabled above. Without these the
    // filesystem cache is unbounded in both directions: the on-disk pack
    // (node_modules/.cache/webpack) grows past 10 GB because entries default
    // to a 60-day maxAge with no compression, and the dev process RSS creeps
    // toward the heap ceiling because deserialized cache entries stay in the
    // in-memory cache for 5 idle compilations (webpack's dev default) and
    // serialization buffers are never released.
    if (cfg.cache && typeof cfg.cache === "object" && cfg.cache.type === "filesystem") {
      cfg.cache.compression = "gzip"
      cfg.cache.maxAge = 7 * 24 * 60 * 60 * 1000
      cfg.cache.allowCollectingMemory = true
      if (cfg.mode === "development") cfg.cache.maxMemoryGenerations = 1
    }

    cfg.resolve ??= {}
    // Mirror of next.config.ts:181 — Node built-ins resolve to `false` in the
    // browser bundle so any transitive dep that imports them doesn't blow up.
    cfg.resolve.fallback = {
      ...(cfg.resolve.fallback ?? {}),
      ...Object.fromEntries(
        [...NODE_ONLY_MODULES, ...OPTIONAL_SERVER_PACKAGES].map((m) => [m, false])
      ),
    }
    cfg.resolve.alias = {
      ...(cfg.resolve.alias ?? {}),
      // Mirror of next.config.ts:188 — collapse pixi to its single-file dist.
      "pixi.js$": PIXI_PREBUNDLED_ABS,
      // Replace the LLM-backed follow-ups hook with a controllable mock so the
      // follow-up-suggestions story never calls a model.
      "@/hooks/chat/use-follow-up-suggestions$": FOLLOW_UPS_MOCK,
    }
    return cfg
  },
}

export default config
