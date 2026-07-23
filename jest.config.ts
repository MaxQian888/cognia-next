/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 *
 * Two-project split (node / jsdom): jsdom costs roughly an order of magnitude
 * more per-suite setup than the node environment, and ~half of the ~5k suites
 * never touch the DOM. Suites are routed by path + extension:
 *
 *   - `node` project — `*.test.ts` / `*.test.mts` (NOT .tsx) under
 *     lib/, stores/, cli/, packages/, types/, plugins/, i18n/ run in the
 *     `node` environment. DOM-needing `.ts` tests in those trees opt back
 *     into jsdom with a leading docblock: `/** @jest-environment jsdom *​/`
 *     (the docblock always beats the project default — ~600 files use one).
 *   - `jsdom` project — everything else: components/, hooks/, app/, every
 *     `.test.tsx`, and any new top-level directory (safe default).
 *
 * Known node-env traps (from the migration audit): `getDb()` throws without
 * `window` (lib/db/schema.ts) so ALL Dexie-touching tests need the jsdom
 * docblock; `localStorage`/`navigator` don't exist in Node 20's node env;
 * the plugin consent auto-responder in jest.setup.ts is window-gated, so a
 * node-env test that triggers a dangerous-permission consent hangs to the
 * broker's 30s timeout instead of auto-allowing.
 */

import { readFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

import type { Config } from "jest"
import nextJest from "next/jest.js"

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
})

// Coverage runs are dramatically more memory-hungry than plain test runs. The
// V8 coverage provider makes every worker retain coverage maps for the *union*
// of every module graph it has loaded, and `collectCoverageFrom` forces the
// main process to build an "empty coverage" istanbul map for all ~3k source
// files — a single-threaded ~2GB cost on its own (measured: a 1-test
// `--coverage` run already peaks at ~1.9GB and takes ~35s, none of it the
// test). Plain `jest` runs pay neither cost, so the clamps below are scoped to
// coverage only and the fast non-coverage path keeps Jest's defaults.
const isCoverage = process.env.JEST_COVERAGE === "1" || process.argv.includes("--coverage")

// Memory signal for worker budgeting. `os.freemem()` alone is unusable on
// macOS (and Linux, which reports MemFree not MemAvailable): the OS counts
// reclaimable file cache as "used", so a 48GB Mac routinely reports ~2GB free
// and the RAM budget collapses to 1 worker. Treat at least 60% of physical
// RAM as available — the file cache yields under pressure — while still
// honoring a genuinely-free reading when it is higher.
const usableMemGb = Math.max(os.freemem(), os.totalmem() * 0.6) / 1e9

// Pick the coverage worker count from whichever is scarcer: CPU or RAM.
// Budget ~1.5GB of usable RAM per worker and reserve ~2GB for the parent's
// empty-coverage aggregation. This self-tunes across machines — a RAM-rich CI
// box stays CPU-bound (50% of cores), while a high-core but RAM-modest dev
// box drops the worker count so heavy coverage workers don't swap-thrash.
const halfCores = Math.max(1, Math.ceil(os.cpus().length / 2))
const ramBudgetedWorkers = Math.max(1, Math.floor((usableMemGb - 2) / 1.5))
const coverageWorkers = Math.min(halfCores, ramBudgetedWorkers)

// Non-coverage runs: the old fixed "50% of cores + 1GB recycle ceiling" left
// half the cores idle and — because the big suites' module graphs sit right
// at ~1–1.5GB — recycled workers constantly, re-requiring the whole graph
// each time. When usable RAM can hold 75%-of-cores workers at a 2GB ceiling,
// use that; otherwise keep the conservative legacy values.
const fastCpuWorkers = Math.max(1, Math.floor(os.cpus().length * 0.75))
const fastRamWorkers = Math.floor((usableMemGb - 2) / 2)
const fastRoomy = fastRamWorkers >= fastCpuWorkers

// This config is loaded two ways depending on the Node version: ts-node
// compiles it to CJS (`__dirname` defined), while Node ≥ 22.18's native
// type-stripping `import()`s it as ESM (`__dirname` undefined, and
// `import.meta` would be a syntax error under the CJS compile). The typeof
// guard works in both worlds; jest is always invoked from the repo root, so
// `process.cwd()` is the same directory.
const CONFIG_DIR = typeof __dirname === "undefined" ? process.cwd() : __dirname

// jest 30.4 stopped normalizing path separators when substituting `<rootDir>`
// into testMatch globs, so on Windows the backslashed prefix breaks micromatch
// and a `<rootDir>`-anchored project silently discovers ZERO tests. Anchor the
// node project's globs on a posix-slashed absolute root instead.
const POSIX_ROOT_DIR = CONFIG_DIR.replace(/\\/g, "/")

// Directories whose plain-.ts tests default to the node environment. A new
// top-level directory is NOT automatically node — it lands in the jsdom
// project until it is added here, which is the safe direction.
const NODE_ENV_DIRS = "{lib,stores,cli,packages,types,plugins,i18n}"
// Regex twin of the node project's testMatch, used to EXCLUDE those files
// from the jsdom project so no suite runs twice. Must stay in sync with
// NODE_ENV_DIRS / the node testMatch globs below.
const NODE_ENV_TEST_REGEXES = [
  "<rootDir>/(?:lib|stores|cli|packages|types|plugins|i18n)/.*__tests__/.*\\.[mc]?ts$",
  "<rootDir>/(?:lib|stores|cli|packages|types|plugins|i18n)/.*(?:/|\\.)(?:spec|test)\\.[mc]?ts$",
]

// An array of regexp pattern strings that are matched against all test paths, matched tests are skipped.
// `/sidecar/` is excluded because the sidecar's `.mjs` tests use Node's
// built-in `--test` runner (see `pnpm sidecar:test`), not Jest. The two test
// surfaces have different setup expectations and should not be run together.
const baseTestPathIgnorePatterns = [
  "/node_modules/",
  "/.next/",
  "/out/",
  "/src-tauri/",
  "/sidecar/",
  // `services/workspace-runtime/` uses Node's built-in `node:test` runner.
  // Importing those TAP suites through Jest reports an empty Jest suite while
  // the nested tests keep running in the background.
  "/services/workspace-runtime/",
  // `services/share-server/` (worker + viewer) is a standalone Vitest
  // workspace with its own package.json/node_modules — same arrangement as
  // `sidecar/`. Its specs `import` from `vitest` and `cloudflare:test`, which
  // Jest's CJS loader can't resolve. Run them via the share-server workspace's
  // own `vitest` / `wrangler` scripts, not the root Jest suite.
  "/share-server/",
  // `tmp/` is gitignored (see .gitignore) — a local-only vendored clone of
  // the CUA TypeScript libs whose tests target Vitest. Never run under Jest.
  "/tmp/",
  "/tests/e2e/", // Playwright E2E tests — run via `pnpx playwright test`, not Jest
  // scripts/*.test.mjs use Node's built-in `node --test` runner (ESM with
  // `import.meta.url` / `__dirname = dirname(fileURLToPath(...))`) which
  // collides with Jest's Babel/CJS transform. They are exercised by
  // `pnpm sidecar:test` and dedicated `node --test` invocations.
  "/scripts/.*\\.test\\.mjs$",
  // Worktree-local override: the parent `jest.config.ts` adds
  // `/\\.claude/worktrees/` here so the root suite doesn't pick up worktree
  // copies of test files; this worktree's local config drops those entries
  // so its own tests run.
]

// Options scoped to a Jest *project* (as opposed to the global config below).
// Both env projects share everything except displayName / testEnvironment /
// testMatch / the jsdom project's extra ignore patterns.
const projectCommon: Config = {
  // Automatically clear mock calls, instances, contexts and results before every test
  clearMocks: true,

  // An array of file extensions your modules use
  moduleFileExtensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "node"],

  // A map from regular expressions to module names or to arrays of module names that allow to stub out resources with a single module
  moduleNameMapper: {
    // Internal provider workspace packages (@cognia/provider-*) resolve to their
    // source tree, not dist — dev/test never depend on a build step (the dist is
    // only produced to prove each package compiles standalone). These MUST come
    // before the broad `^@/` rule below; Jest tries entries in order.
    "^@cognia/provider-types(.*)$": "<rootDir>/packages/provider-types/src$1",
    "^@cognia/provider-core(.*)$": "<rootDir>/packages/provider-core/src$1",
    "^@cognia/provider-embedding(.*)$": "<rootDir>/packages/provider-embedding/src$1",
    "^@cognia/provider-routing(.*)$": "<rootDir>/packages/provider-routing/src$1",
    "^@cognia/rag(.*)$": "<rootDir>/packages/rag/src$1",
    "^@cognia/error-parsers(.*)$": "<rootDir>/packages/error-parsers/src$1",
    "^@cognia/vector(.*)$": "<rootDir>/packages/vector/src$1",
    "^@cognia/transformers-runtime$": "<rootDir>/packages/transformers-runtime/src/index.ts",
    "^@cognia/transformers-runtime/(.*)$": "<rootDir>/packages/transformers-runtime/src/$1",
    "^@cognia/document(.*)$": "<rootDir>/packages/document/src$1",
    "^@cognia/agent-trace(.*)$": "<rootDir>/packages/agent-trace/src$1",
    "^@cognia/primitives(.*)$": "<rootDir>/packages/primitives/src$1",
    "^@cognia/time(.*)$": "<rootDir>/packages/time/src$1",
    "^@cognia/latex(.*)$": "<rootDir>/packages/latex/src$1",
    "^@cognia/mermaid(.*)$": "<rootDir>/packages/mermaid/src$1",
    "^@cognia/plugin-sdk$": "<rootDir>/packages/plugin-sdk/src/index.ts",
    "^@cognia/plugin-sdk/(manifest|context|events|hooks|permissions|extensions)$":
      "<rootDir>/packages/plugin-sdk/src/$1/index.ts",
    "^@cognia/plugin-sdk/contracts$": "<rootDir>/packages/plugin-sdk/src/contracts/catalog.ts",
    "^@cognia/plugin-sdk/api/(tool|native-anthropic-tool)$":
      "<rootDir>/packages/plugin-sdk/src/api/$1.ts",
    "^@cognia/redact(.*)$": "<rootDir>/packages/redact/src$1",
    "^@cognia/web-search(.*)$": "<rootDir>/packages/web-search/src$1",
    "^@cognia/tts(.*)$": "<rootDir>/packages/tts/src$1",
    "^@cognia/logging(.*)$": "<rootDir>/packages/logging/src$1",
    "^@cognia/agent-config-types(.*)$": "<rootDir>/packages/agent-config-types/src$1",
    "^@cognia/memory(.*)$": "<rootDir>/packages/memory/src$1",
    "^@cognia/ocr(.*)$": "<rootDir>/packages/ocr/src$1",

    // cheerio's package exports prefer the ESM browser build under jsdom.
    // The HTML parser uses dynamic import("cheerio"), so map Jest to the CJS
    // build that the CommonJS runtime can execute.
    "^cheerio$": "<rootDir>/node_modules/cheerio/dist/commonjs/index.js",

    // streamdown 2.5 exposes only an ESM `import` condition and its bundled
    // output remains ESM after next/jest's node_modules handling. Tests assert
    // our wrappers, so use a small rendering-compatible CJS boundary.
    "^streamdown$": "<rootDir>/__mocks__/streamdown.js",

    // Handle module aliases (this will be automatically configured for you by Next.js)
    "^@/(.*)$": "<rootDir>/$1",

    // Handle CSS imports (with CSS modules)
    "^.+\\.module\\.(css|sass|scss)$": "identity-obj-proxy",

    // Handle CSS imports (without CSS modules)
    "^.+\\.(css|sass|scss)$": "<rootDir>/__mocks__/styleMock.js",

    // Handle image imports
    "^.+\\.(png|jpg|jpeg|gif|webp|avif|ico|bmp|svg)$/i": "<rootDir>/__mocks__/fileMock.js",

    // Mock Tauri API for Jest (not available in jsdom)
    "^@tauri-apps/api/core$": "<rootDir>/__mocks__/tauri-api.js",
    "^@tauri-apps/api/event$": "<rootDir>/__mocks__/tauri-api-event.js",
    "^@tauri-apps/plugin-store$": "<rootDir>/__mocks__/tauri-plugin-store.js",

    // nanoid ships ESM-only browser entry that Jest's CommonJS loader can't
    // parse. Map to the CommonJS build under nanoid/non-secure for tests.
    "^nanoid$": "<rootDir>/__mocks__/nanoid.js",

    // @opencode-ai/sdk is pure ESM with subpath exports. Mock the client
    // surface used by the agent manager so Jest can resolve the module graph.
    "^@opencode-ai/sdk/client$": "<rootDir>/__mocks__/opencode-sdk-client.js",
    "^@opencode-ai/sdk$": "<rootDir>/__mocks__/opencode-sdk-client.js",

    // shiki ships ESM-only and Next.js's transformIgnorePatterns whitelist
    // is short enough to leave it untransformed. Tests don't render real
    // syntax highlighting, so a thin mock is sufficient.
    "^shiki$": "<rootDir>/__mocks__/shiki.js",

    // ink (v7) + ink-spinner are ESM-only with a deep ESM dependency chain that
    // next/jest does not transform — same situation as shiki / react-markdown.
    // The standalone CLI's TUI uses real ink at runtime (esbuild bundle, native
    // ESM); Jest renders the thin `.tsx` components through these DOM-backed
    // mocks (`<Box>`→`<div>`, `<Text>`→`<span>`) so RTL can assert on them.
    "^ink$": "<rootDir>/__mocks__/ink.js",
    "^ink-spinner$": "<rootDir>/__mocks__/ink-spinner.js",

    // chalk (v5) is ESM-only and resolves under pnpm's `.pnpm/` layout, which
    // next/jest's transformIgnorePatterns always excludes from transformation —
    // so the real module can't load under Jest. The mock is a no-colour
    // passthrough (matching chalk in a non-TTY env). Only the TUI highlighter
    // imports it.
    "^chalk$": "<rootDir>/__mocks__/chalk.js",

    // motion/react (formerly framer-motion) doesn't synchronously project
    // its `animate` target into inline style under jsdom — there's no
    // animation loop. Tests that assert on the post-animation style need
    // a mock that merges `animate` into `style` at render time.
    "^motion/react$": "<rootDir>/__mocks__/motion-react.js",

    // react-markdown and its remark/rehype plugin ecosystem are ESM-only.
    // Instead of fighting pnpm's two-layer path layout with transformIgnorePatterns,
    // we redirect them to CJS-compatible manual mocks. The react-markdown mock
    // provides a functional line-based markdown parser sufficient for unit tests.
    "^react-markdown$": "<rootDir>/__mocks__/react-markdown.js",
    "^@streamdown/cjk$": "<rootDir>/__mocks__/streamdown-cjk.js",
    "^rehype-sanitize$": "<rootDir>/__mocks__/rehype-sanitize.js",
    "^remark-gfm$": "<rootDir>/__mocks__/esm-plugin-stub.js",
    "^remark-math$": "<rootDir>/__mocks__/esm-plugin-stub.js",
    "^rehype-raw$": "<rootDir>/__mocks__/esm-plugin-stub.js",

    // The Live2D engine + pixi.js are WebGL/Cubism runtimes jsdom can't host.
    // The pet Live2D loader does `import("untitled-pixi-live2d-engine/cubism")`
    // and `import("pixi.js")`; both map to lightweight jest-fn stubs so the
    // module graph resolves and tests can assert on the engine/app surface.
    "^untitled-pixi-live2d-engine/cubism$": "<rootDir>/__mocks__/untitled-pixi-live2d-engine.js",
    "^untitled-pixi-live2d-engine$": "<rootDir>/__mocks__/untitled-pixi-live2d-engine.js",
    "^pixi\\.js$": "<rootDir>/__mocks__/pixi.js.js",

    // @octokit/* v7 packages are pure ESM and Next.js's transform doesn't
    // strip ESM imports inside node_modules. Manual mocks expose only the
    // surface our lib/github/* modules use.
    "^@octokit/core$": "<rootDir>/__mocks__/@octokit/core.js",
    "^@octokit/auth-token$": "<rootDir>/__mocks__/@octokit/auth-token.js",
    "^@octokit/auth-app$": "<rootDir>/__mocks__/@octokit/auth-app.js",
    "^@octokit/plugin-throttling$": "<rootDir>/__mocks__/@octokit/plugin-throttling.js",
    "^@octokit/plugin-retry$": "<rootDir>/__mocks__/@octokit/plugin-retry.js",
  },

  // An array of regexp pattern strings, matched against all module paths before considered 'visible' to the module loader
  modulePathIgnorePatterns: ["<rootDir>/out/", "<rootDir>/.next/", "<rootDir>/target/"],

  // A list of paths to modules that run some code to configure or set up the testing framework before each test.
  // jest.setup.ts is env-agnostic — every DOM touch is behind a
  // `typeof window !== "undefined"` guard, so it serves both projects.
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],

  testPathIgnorePatterns: baseTestPathIgnorePatterns,

  // Several ported npm packages are ESM-only (no CJS dist), so Jest's default
  // CJS loader trips on `export` keywords. The pattern below uses a negative
  // lookahead applied to the *entire remainder of the path*, which is the
  // only form that survives pnpm's two-layer
  // `.pnpm/<scope>+<pkg>@<ver>/node_modules/<scope>/<pkg>` layout. Add new
  // ESM packages to the negative-lookahead alternation as they surface.
  transformIgnorePatterns: [
    "/node_modules/(?!.*(?:@qdrant\\+|@qdrant/|@huggingface\\+|@huggingface/|chromadb|@chroma-core|@pinecone-database\\+|@pinecone-database/|weaviate-client|simple-git|onnxruntime-common|@tokenlens\\+|@tokenlens/|use-stick-to-bottom|tokenlens|shiki|@shikijs|@streamdown|streamdown|hast-util-|mdast-util-|micromark|unist-util-|vfile|react-markdown|remark-gfm|remark-math|rehype-raw|rehype-sanitize|remark-parse|remark-rehype|rehype-stringify|unified|bail|is-plain-obj|trough|zwitch|ccount|character-entities|comma-separated-tokens|decode-named-character-reference|devlop|extend|html-void-elements|longest-streak|property-information|space-separated-tokens|stringify-entities|web-namespaces|@octokit\\+|@octokit/|universal-user-agent|before-after-hook|deprecation|once|wrappy|btoa-lite|fast-content-type-parse|toad-cache|bottleneck|@types\\+|@types/|@modelcontextprotocol\\+|@modelcontextprotocol/|@xyflow\\+|@xyflow/|chart\\.js|cheerio))",
    "\\.pnp\\.[^\\\\]+$",
  ],
}

// Global (non-project) options: coverage, workers, reporters.
const globalConfig: Config = {
  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: false, // Set to false by default, enable with --coverage flag

  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: [
    "app/**/*.{js,jsx,ts,tsx}",
    "components/**/*.{js,jsx,ts,tsx}",
    "hooks/**/*.{js,jsx,ts,tsx}",
    "lib/**/*.{js,jsx,ts,tsx}",
    // First-party Work Mode is a browser-bundled plugin and follows the same
    // co-located ≥90% coverage contract as host modules.
    "plugins/cognia-work-mode/src/**/*.{ts,tsx}",
    "!plugins/cognia-work-mode/src/**/*.test.{ts,tsx}",
    // The overlay is shipped as a string and loaded by its suites via
    // readFileSync + eval, so V8 cannot attribute any coverage to it and all
    // ~1.8k lines report 0% — diluting the `global` bucket (the
    // `./lib/**/*.{ts,tsx}` group doesn't match `.js`). Its behavior is covered
    // by overlay.injected.test.ts + overlay.injected.record.test.ts.
    "!lib/browser/overlay.injected.js",
    "stores/**/*.{js,jsx,ts,tsx}",
    // Extracted provider workspace packages. provider-core originated from
    // lib/ai/providers (coverage-gated), so keep it collected. provider-types is
    // NOT listed — it came from types/, which was never coverage-collected.
    "packages/provider-core/src/**/*.{ts,tsx}",
    "packages/provider-embedding/src/**/*.{ts,tsx}",
    "packages/provider-routing/src/**/*.{ts,tsx}",
    // rag was lifted out of lib/ai/rag (coverage-collected), so keep it collected.
    "packages/rag/src/**/*.{ts,tsx}",
    // error-parsers was lifted out of lib/error-parsers (coverage-collected).
    "packages/error-parsers/src/**/*.{ts,tsx}",
    // memory core was lifted out of lib/memory (coverage-collected), so keep it collected.
    "packages/memory/src/**/*.{ts,tsx}",
    // ocr core was lifted out of lib/ocr (coverage-collected), so keep it collected.
    "packages/ocr/src/**/*.{ts,tsx}",
    // vector / document / agent-trace were lifted out of lib/* (coverage-collected).
    "packages/vector/src/**/*.{ts,tsx}",
    "packages/transformers-runtime/src/**/*.{ts,tsx}",
    "!packages/transformers-runtime/src/types.ts",
    "packages/document/src/**/*.{ts,tsx}",
    "packages/agent-trace/src/**/*.{ts,tsx}",
    // primitives / time / latex / mermaid were lifted out of lib/* (coverage-collected).
    "packages/primitives/src/**/*.{ts,tsx}",
    "packages/time/src/**/*.{ts,tsx}",
    "packages/latex/src/**/*.{ts,tsx}",
    "packages/mermaid/src/**/*.{ts,tsx}",
    "packages/plugin-sdk/src/**/*.{ts,tsx}",
    // redact was lifted out of lib/twin/ingest (coverage-collected), so keep
    // it collected.
    "packages/redact/src/**/*.{ts,tsx}",
    // web-search was lifted out of lib/search (coverage-collected).
    "packages/web-search/src/**/*.{ts,tsx}",
    // tts was lifted out of lib/tts (coverage-collected). types.ts came from
    // types/media/tts.ts, which carried runtime tables (TTS_PROVIDERS,
    // getTTSError) and its own test, so it stays collected too. The index
    // barrel has no importers (consumers deep-import submodules), so its
    // re-export statements never execute under Jest — exclude it.
    "packages/tts/src/**/*.{ts,tsx}",
    "!packages/tts/src/index.ts",
    // logging core was lifted out of lib/logging (coverage-collected). Its
    // types/ subtree came from types/logging, which was never
    // coverage-collected (provider-types precedent), so it is excluded.
    "packages/logging/src/**/*.{ts,tsx}",
    "!packages/logging/src/types/**",
    // agent-config-types' hub came from lib/claude/types.ts (coverage-
    // collected: it carries runtime event guards + default tables). The
    // lsp-config/compression/pet-settings leaves came from types/**, which
    // was never coverage-collected (provider-types precedent).
    "packages/agent-config-types/src/index.ts",
    "!packages/plugin-sdk/src/context/**/*.ts",
    "!packages/plugin-sdk/src/hooks/index.ts",
    "!packages/plugin-sdk/src/permissions/index.ts",
    "!packages/plugin-sdk/src/api/workflow.ts",
    "!packages/**/*.test.ts",
    "!packages/**/dist/**",
    // Standalone agent CLI (lives in the main TS graph so it reuses lib/claude/*).
    "cli/src/**/*.ts",
    "!cli/src/cli/entry.ts", // thin executable wrapper — no unit test
    "!cli/src/**/*.test.ts",
    // Type-only TUI modules — TS strips them at runtime so V8 reports 0%, even
    // though tests assert on the public surface. Same exemption as the type
    // modules listed below. (TUI `.tsx` components are not in this glob — it
    // collects `*.ts` only — so thin ink renderers are co-located-tested but
    // not coverage-gated; all gated logic lives in pure `.ts` modules.)
    "!cli/src/tui/**/types.ts",
    "!stores/**/types.ts",
    "!hooks/**/index.ts",
    // Type-only modules — TS strips them at runtime, so V8 records 0 coverage
    // even though tests assert on the public surface.
    "!lib/claude/hooks.ts",
    "!lib/data/importers/types.ts",
    "!lib/skills/marketplace-types.ts",
    // Pure type/interface modules — TS strips them at runtime, so V8 always
    // reports 0%. Same exemption pattern as the four entries above.
    "!lib/storage/persistence/types.ts",
    "!lib/wiki/types.ts",
    "!lib/tauri/transport-types.ts",
    "!hooks/a2ui/app-builder/types.ts",
    "!lib/data-hooks/types.ts",
    "!lib/code-adoption/types.ts",
    "!lib/db/a2ui-types.ts",
    "!lib/db/plugin-types.ts",
    "!lib/db/connector-types.ts",
    "!lib/connectors/activity/diff-types.ts",
    "!lib/ai/agent/team/auto/types.ts",
    "!lib/claude/subagent-importers/types.ts",
    "!lib/perf/backend/types.ts",
    "!lib/memory/external/types.ts",
    "!lib/execution/types.ts",
    "!lib/pet/live2d/types.ts",
    "!lib/a2ui/from-execution/types.ts",
    "!lib/attention/types.ts",
    "!lib/chat/mentions/types.ts",
    "!lib/claude/agents/subagents/types.ts",
    "!lib/db/behavior-event-types.ts",
    "!lib/db/crm-types.ts",
    "!lib/db/inbox-telemetry-types.ts",
    "!lib/headless/types.ts",
    "!lib/scheduler/sources/types.ts",
    "!lib/session-import/types.ts",
    "!lib/share/types.ts",
    "!lib/shortcuts/types.ts",
    "!lib/skills/built-in/types.ts",
    "!lib/sync/types.ts",
    "!lib/task-workspace/types.ts",
    "!lib/terminal/types.ts",
    "!lib/terminal/completion/spec/types.ts",
    "!lib/tray/types.ts",
    "!lib/webdav/types.ts",
    "!lib/workflow/copilot-templates/types.ts",
    "!lib/workflow/nodes/typed-params.ts",
    "!packages/memory/src/llm/types.ts",
    "!packages/memory/src/types/governance.ts",
    "!packages/ocr/src/types/document.ts",
    "!packages/ocr/src/types/platform.ts",
    "!packages/tts/src/providers/adapter.ts",
    "!components/editor/diagnostics/types.ts",
    // The ACP / OpenCode external-agent protocol adapters are 1.5k–2.5k LOC
    // of stdio + JSON-RPC + Tauri-IPC plumbing that only runs against a real
    // subprocess. jsdom can stub the surface but can't drive the live
    // protocol — full coverage requires the Rust integration tests under
    // `src-tauri/`. Exclude here so they don't drag the lib/** gate down.
    "!lib/ai/agent/external/acp-client.ts",
    "!lib/ai/agent/external/manager.ts",
    "!lib/ai/agent/external/opencode-client.ts",
    // search-type-router.ts is a 40+ provider dispatch table. Each provider
    // has its own co-located test, but exercising every dispatch leg here
    // would just duplicate those — it's a routing surface with very low
    // branch density.
    "!packages/web-search/src/search-type-router.ts",
    // Storybook stories are dev-preview artifacts, not production source — they
    // would otherwise count as uncovered code and sink the ≥90% gate.
    "!**/*.stories.{js,jsx,ts,tsx}",
    // Storybook-only test infra (store/DB seeding + fixture builders). Same
    // dev-preview rationale as stories — never imported by production code.
    "!lib/storybook/**",
    "!**/*.d.ts",
    "!**/node_modules/**",
    "!**/.next/**",
    "!**/coverage/**",
    "!**/out/**",
  ],

  // The directory where Jest should output its coverage files
  coverageDirectory: "coverage",

  // An array of regexp pattern strings used to skip coverage collection.
  // `components/ui/` and `components/ai-elements/` are vendored shadcn/ui +
  // ai-elements primitives and are excluded per CLAUDE.md.
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/.next/",
    "/out/",
    "/coverage/",
    "/components/ui/",
    "/components/ai-elements/",
  ],

  // Indicates which provider should be used to instrument code for coverage
  coverageProvider: "v8",

  // A list of reporter names that Jest uses when writing coverage reports.
  // Trimmed to the two that are actually consumed, because every reporter walks
  // and serializes the full coverage map (~3k files) in the main process at the
  // tail of the run, multiplying peak RSS:
  //   - `lcov`     → CI reads `coverage/lcov-report/index.html` (the workflow
  //                  summary step) and the optional Codecov upload reads
  //                  `coverage/lcov.info`; both come from this one reporter.
  //   - `text-summary` → a single-block console total (the per-file `text`
  //                  table builds ~3k formatted rows in the parent for no CI
  //                  consumer; open the lcov HTML report for per-file detail).
  // `json` / `html` (redundant with lcov's bundled HTML) / `clover` /
  // `cobertura` had no active consumer — re-add a specific one if a tool needs
  // it. `coverage/junit.xml` is produced by the separate `jest-junit` reporter
  // below and is unaffected. Sharded CI overrides this with
  // `--coverageReporters=json` and regenerates lcov at the merge step.
  coverageReporters: ["text-summary", "lcov"],

  // Coverage thresholds — enforced by `pnpm test:coverage` and CI.
  //
  // Layering: per-path thresholds remove their files from the `global`
  // aggregate (per Jest docs). When two thresholds match the same file, BOTH
  // apply, so per-file overrides can only ADD to the broader glob, never
  // exempt a file from it. To genuinely exempt a file, exclude it from
  // `collectCoverageFrom` above.
  // The threshold groups live in `scripts/test/coverage-thresholds.json` so
  // the sharded-CI merge step (`scripts/test/merge-coverage.mjs`) can enforce
  // the exact same gates after merging per-shard coverage maps (per-shard runs
  // disable thresholds — a shard only sees partial coverage for any file whose
  // tests landed on another shard, so in-run checks would misfire).
  //
  // Group rationale (history lives with the JSON's git log):
  //   - ./stores/** — CLAUDE.md "Testing Standards": ≥90% on every metric.
  //   - ./lib/** — regression floor from the lib-synthetic-swing Phase 2 pass,
  //     calibrated to the worst performer (lib/data/backup-key.ts branches=50).
  //   - ./packages/*/src — each package lifted out of lib/* keeps the same
  //     floor lib/** carried so enforcement isn't lost in the move.
  //   - ./hooks/** — realistic floor; the big IPC orchestrator hooks are
  //     exercised via component-level integration tests.
  //   - ./components/logging/** — floor set by the two largest files whose
  //     inline handlers are covered by app/logs integration.
  //   - global — app/* + components/* remainder; raise after the components/
  //     per-file coverage push.
  coverageThreshold: JSON.parse(
    // `CONFIG_DIR`, not `__dirname`/import.meta — see the dual CJS/ESM
    // loading note at the top of this file.
    readFileSync(join(CONFIG_DIR, "scripts/test/coverage-thresholds.json"), "utf8")
  ) as Config["coverageThreshold"],

  // Cap workers at 50% so the deep-import suites (twin / plugin / agent
  // graphs) don't gang up on a single Node process and OOM with
  // `ENOMEM: not enough memory, open '…semver/sort.js'` mid-run. Jest's
  // default uses every core, which on a 16-core box pulls the same
  // 2 GB-class module graph into RAM 15+ times concurrently.
  //
  // Under `--coverage` each worker is far heavier (it also retains V8 coverage
  // maps for every module it loads), so 50%-of-cores (16 on a 32-core box) was
  // measured at ~8.8 GB of Jest RSS across 17 processes for a 121-file subset —
  // the full suite holds those 16 workers the whole run. `coverageWorkers`
  // (computed above) drops to whatever usable RAM can afford so the coverage
  // run no longer swap-thrashes; non-coverage runs use 75% of cores when RAM
  // is roomy (see `fastRoomy` above) and fall back to the legacy 50% cap.
  maxWorkers: isCoverage ? coverageWorkers : fastRoomy ? fastCpuWorkers : "50%",

  // Recycle a worker once its heap crosses this ceiling. Jest reuses a worker
  // process across many test files and never clears the module registry
  // between them (`resetModules` is off by design, for speed), so a single
  // worker accumulates the *union* of every module graph it has loaded. With
  // the suite past 2.7k files (~160 files per worker on a 32-core box) a worker
  // climbs to ~1.5 GB after just ~10 component files and stays pinned there.
  // Restarting a worker resets its registry to zero and bounds total RSS
  // without lowering parallelism. Coverage workers carry the extra V8 coverage
  // maps, so we recycle them sooner (768MB) to keep the (already RAM-budgeted)
  // pool's footprint low; non-coverage workers keep the 1GB ceiling tuned for
  // the plain suite.
  workerIdleMemoryLimit: isCoverage ? "768MB" : fastRoomy ? "2GB" : "1GB",

  // Use this configuration option to add custom reporters to Jest
  reporters: [
    "default",
    [
      "jest-junit",
      {
        outputDirectory: "coverage",
        outputName: "junit.xml",
        classNameTemplate: "{classname}",
        titleTemplate: "{title}",
        ancestorSeparator: " › ",
        usePathForSuiteName: true,
      },
    ],
  ],
}

// next/jest wraps each *project* (it injects the SWC transform, CSS/image
// mappers, env loading — all project-scope concerns).
const createNodeProject = createJestConfig({
  ...projectCommon,
  displayName: "node",
  testEnvironment: "node",
  // Plain-.ts (and .mts/.cts) tests in the node-safe trees. `.tsx` is
  // deliberately absent — React-rendering suites always need jsdom.
  // POSIX_ROOT_DIR, not `<rootDir>` — jest 30.4's raw substitution leaves
  // Windows backslashes in the glob, which micromatch treats as escapes and
  // matches nothing (the whole node project vanished from discovery).
  testMatch: [
    `${POSIX_ROOT_DIR}/${NODE_ENV_DIRS}/**/__tests__/**/*.?([mc])ts`,
    `${POSIX_ROOT_DIR}/${NODE_ENV_DIRS}/**/?(*.)+(spec|test).?([mc])ts`,
  ],
})

const createJsdomProject = createJestConfig({
  ...projectCommon,
  displayName: "jsdom",
  testEnvironment: "jsdom",
  // The glob patterns Jest uses to detect test files
  testMatch: ["**/__tests__/**/*.?([mc])[jt]s?(x)", "**/?(*.)+(spec|test).?([mc])[jt]s?(x)"],
  // Exclude everything the node project owns so no suite runs twice.
  testPathIgnorePatterns: [...baseTestPathIgnorePatterns, ...NODE_ENV_TEST_REGEXES],
})

const buildConfig = async (): Promise<Config> => ({
  ...globalConfig,
  projects: [await createNodeProject(), await createJsdomProject()],
})

export default buildConfig
