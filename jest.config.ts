/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type { Config } from "jest"
import nextJest from "next/jest.js"

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
})

const config: Config = {
  // Automatically clear mock calls, instances, contexts and results before every test
  clearMocks: true,

  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: false, // Set to false by default, enable with --coverage flag

  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: [
    "app/**/*.{js,jsx,ts,tsx}",
    "components/**/*.{js,jsx,ts,tsx}",
    "hooks/**/*.{js,jsx,ts,tsx}",
    "lib/**/*.{js,jsx,ts,tsx}",
    "stores/**/*.{js,jsx,ts,tsx}",
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
    "!lib/ccswitch/types.ts",
    "!lib/data-hooks/types.ts",
    "!lib/db/a2ui-types.ts",
    "!lib/db/plugin-types.ts",
    "!lib/db/connector-types.ts",
    "!lib/claude/subagent-importers/types.ts",
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
    "!lib/search/search-type-router.ts",
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

  // A list of reporter names that Jest uses when writing coverage reports
  coverageReporters: ["json", "text", "lcov", "html", "clover", "cobertura"],

  // Coverage thresholds — enforced by `pnpm test:coverage` and CI.
  //
  // Layering: per-path thresholds remove their files from the `global`
  // aggregate (per Jest docs). When two thresholds match the same file, BOTH
  // apply, so per-file overrides can only ADD to the broader glob, never
  // exempt a file from it. To genuinely exempt a file, exclude it from
  // `collectCoverageFrom` above.
  coverageThreshold: {
    // Per CLAUDE.md "Testing Standards": stores/ must hit ≥90% on every metric.
    // Scoped here so the gate covers the refactored store tree without forcing
    // legacy app/ + components/ files to the same bar in the same PR.
    "./stores/**/*.{ts,tsx}": {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
    // lib/ went through Phase 2 of the lib-synthetic-swing plan: every source
    // file has a co-located test (apart from the type-only and runtime-only
    // modules listed in `collectCoverageFrom` exclusions). The folder average
    // sits at 95%+ statements and 90%+ lines. The threshold below is a
    // regression floor calibrated to the current worst-performer in lib/
    // (`lib/data/backup-key.ts` at branches=50%). Future work should raise
    // this gate as outliers like cron-parser and task-scheduler get more
    // dedicated tests.
    "./lib/**/*.{ts,tsx}": {
      branches: 50,
      functions: 60,
      lines: 75,
      statements: 75,
    },
    // hooks/ has co-located tests for every public hook. The most complex
    // hooks (claude-chat / team-chat / external-agent IPC orchestrators) have
    // event handlers that are exercised through component-level integration
    // tests rather than unit tests, so we set a realistic floor here that
    // still catches regressions but does not fail on the single-file
    // averages that those hooks pull down.
    "./hooks/**/*.{ts,tsx}": {
      branches: 50,
      functions: 30,
      lines: 40,
      statements: 40,
    },
    // components/logging/ was scrubbed in the components-logging-jiggly-petal
    // refactor: fallback wrappers were removed, hardcoded strings were replaced
    // with i18n keys, raw HTML primitives were swapped for shadcn equivalents,
    // and responsive breakpoints were added. The threshold below is the floor
    // every co-located test must hold; the two largest files (`log-settings.tsx`
    // 1442 LOC and `log-panel.tsx` 884 LOC) drive the floor for `functions` and
    // `branches` because they contain many inline arrow handlers that are still
    // covered by integration in `app/logs` rather than this unit suite.
    "./components/logging/**/*.{ts,tsx}": {
      branches: 45,
      functions: 20,
      lines: 70,
      statements: 70,
    },
    // Global = app/* + components/* (everything else is path-scoped above).
    // Tuned to the current state of those folders; raise once components/ has
    // its own per-file test coverage push.
    global: {
      branches: 60,
      functions: 30,
      lines: 25,
      statements: 25,
    },
  },

  // An object that configures minimum threshold enforcement for coverage results
  // coverageThreshold: undefined,

  // A path to a custom dependency extractor
  // dependencyExtractor: undefined,

  // Make calling deprecated APIs throw helpful error messages
  // errorOnDeprecated: false,

  // The default configuration for fake timers
  // fakeTimers: {
  //   "enableGlobally": false
  // },

  // Force coverage collection from ignored files using an array of glob patterns
  // forceCoverageMatch: [],

  // A path to a module which exports an async function that is triggered once before all test suites
  // globalSetup: undefined,

  // A path to a module which exports an async function that is triggered once after all test suites
  // globalTeardown: undefined,

  // A set of global variables that need to be available in all test environments
  // globals: {},

  // Cap workers at 50% so the deep-import suites (twin / plugin / agent
  // graphs) don't gang up on a single Node process and OOM with
  // `ENOMEM: not enough memory, open '…semver/sort.js'` mid-run. Jest's
  // default uses every core, which on a 16-core box pulls the same
  // 2 GB-class module graph into RAM 15+ times concurrently.
  maxWorkers: "50%",

  // An array of directory names to be searched recursively up from the requiring module's location
  // moduleDirectories: [
  //   "node_modules"
  // ],

  // An array of file extensions your modules use
  moduleFileExtensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "node"],

  // A map from regular expressions to module names or to arrays of module names that allow to stub out resources with a single module
  moduleNameMapper: {
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
    "^rehype-sanitize$": "<rootDir>/__mocks__/rehype-sanitize.js",
    "^remark-gfm$": "<rootDir>/__mocks__/esm-plugin-stub.js",
    "^remark-math$": "<rootDir>/__mocks__/esm-plugin-stub.js",
    "^rehype-raw$": "<rootDir>/__mocks__/esm-plugin-stub.js",

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
  modulePathIgnorePatterns: ["<rootDir>/out/", "<rootDir>/.next/"],

  // Activates notifications for test results
  // notify: false,

  // An enum that specifies notification mode. Requires { notify: true }
  // notifyMode: "failure-change",

  // A preset that is used as a base for Jest's configuration
  // preset: undefined,

  // Run tests from one or more projects
  // projects: undefined,

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

  // Automatically reset mock state before every test
  // resetMocks: false,

  // Reset the module registry before running each individual test
  // resetModules: false,

  // A path to a custom resolver
  // resolver: undefined,

  // Automatically restore mock state and implementation before every test
  // restoreMocks: false,

  // The root directory that Jest should scan for tests and modules within
  // rootDir: undefined,

  // A list of paths to directories that Jest should use to search for files in
  // roots: [
  //   "<rootDir>"
  // ],

  // Allows you to use a custom runner instead of Jest's default test runner
  // runner: "jest-runner",

  // The paths to modules that run some code to configure or set up the testing environment before each test
  // setupFiles: [],

  // A list of paths to modules that run some code to configure or set up the testing framework before each test
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],

  // The number of seconds after which a test is considered as slow and reported as such in the results.
  // slowTestThreshold: 5,

  // A list of paths to snapshot serializer modules Jest should use for snapshot testing
  // snapshotSerializers: [],

  // The test environment that will be used for testing
  testEnvironment: "jsdom",

  // Options that will be passed to the testEnvironment
  // testEnvironmentOptions: {},

  // Adds a location field to test results
  // testLocationInResults: false,

  // The glob patterns Jest uses to detect test files
  testMatch: ["**/__tests__/**/*.?([mc])[jt]s?(x)", "**/?(*.)+(spec|test).?([mc])[jt]s?(x)"],

  // An array of regexp pattern strings that are matched against all test paths, matched tests are skipped.
  // `/sidecar/` is excluded because the sidecar's `.mjs` tests use Node's
  // built-in `--test` runner (see `pnpm sidecar:test`), not Jest. The two test
  // surfaces have different setup expectations and should not be run together.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/.next/",
    "/out/",
    "/src-tauri/",
    "/sidecar/",
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
  ],

  // The regexp pattern or array of patterns that Jest uses to detect test files
  // testRegex: [],

  // This option allows the use of a custom results processor
  // testResultsProcessor: undefined,

  // This option allows use of a custom test runner
  // testRunner: "jest-circus/runner",

  // A map from regular expressions to paths to transformers
  // transform: undefined,

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

  // An array of regexp pattern strings that are matched against all modules before the module loader will automatically return a mock for them
  // unmockedModulePathPatterns: undefined,

  // Indicates whether each individual test should be reported during the run
  // verbose: undefined,

  // An array of regexp patterns that are matched against all source file paths before re-running tests in watch mode
  // watchPathIgnorePatterns: [],

  // Whether to use watchman for file crawling
  // watchman: true,
}

export default createJestConfig(config)
