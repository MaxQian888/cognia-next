#!/usr/bin/env node
/**
 * Incremental CI test planning and scoped coverage for changed files.
 *
 * `pnpm test:coverage` pays a fixed multi-GB / ~35s tax before running a
 * single test: `collectCoverageFrom` makes the Jest parent build an "empty
 * coverage" map for every one of the ~3k collected source files. When you
 * only want to know "are MY changed files covered", that tax is pure waste.
 *
 * This script:
 *   1. Diffs the working tree + branch against the merge-base with a base ref
 *      (default: origin/dev) and keeps only coverage-collected source files.
 *   2. Runs Jest with `--findRelatedTests` (only suites that import those
 *      files) and `--collectCoverageFrom` narrowed to exactly those files.
 *   3. Disables the config's layered `coverageThreshold` by default — those
 *      globs error when a group has no collected data, which is guaranteed
 *      here. Pass `--strict` to gate every changed file independently at the
 *      CLAUDE.md 90% bar instead.
 *
 * The default base is `origin/dev`, NOT `master`. `dev` is this repo's real
 * trunk; `master` sits ~1500 commits behind it. Diffing against master made
 * "changed files" mean "most of the repo", which turned every incremental
 * check into a full run and made a 90% gate unshippable. CI always passes
 * `--base` explicitly from the event context; this default only serves local
 * invocations.
 *
 * CI planning uses committed base/head SHAs instead of the local coverage
 * diff. It selects direct/colocated/related suites, explicit dependency smoke
 * contracts and conservative deletion fallbacks. Incremental execution never
 * collects coverage; full-mode execution may opt in with --coverage.
 *
 * Usage:
 *   node scripts/test/coverage-changed.mjs --plan --base BASE --head HEAD --output plan.json
 *   node scripts/test/coverage-changed.mjs --run-plan plan.json --shard 1
 *   pnpm test:coverage:changed                        # report-only, vs origin/dev
 *   pnpm test:coverage:changed -- --base origin/main  # different base ref
 *   pnpm test:coverage:changed -- --strict            # enforce 90% on changed files
 */

import { fileURLToPath } from "node:url"
import path from "node:path"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { Command, CommanderError } from "commander"
import { execaSync } from "execa"
import { z } from "zod"
import { checkGroup, mergeCoverageFiles } from "./merge-coverage.mjs"
import timingSequencer from "./jest-timing-sequencer.cjs"

/** Directories whose files are coverage-collected (mirrors jest.config.ts). */
const COLLECTED_ROOTS = [
  /^app\//,
  /^components\//,
  /^hooks\//,
  /^lib\//,
  /^stores\//,
  /^cli\/src\//,
  /^packages\/[^/]+\/src\//,
  // The marketing workspace (ADR-0092), matching `collectCoverageFrom`.
  /^web\/(components|hooks|lib)\//,
]

/**
 * Paths excluded from coverage (mirrors coveragePathIgnorePatterns + globs).
 *
 * `web/components/ui/` needs its own anchored entry: Jest's
 * `coveragePathIgnorePatterns` uses the unanchored `/components/ui/`, which
 * happens to catch the web copy too, but these patterns are anchored at the
 * repo root and would not.
 */
const EXCLUDED = [
  /^components\/ui\//,
  /^components\/ai-elements\//,
  /^web\/components\/ui\//,
  // Explicit type-only and PTY-driver exclusions documented in jest.config.ts.
  /^lib\/claude\/agents\/subagents\/types\.ts$/,
  /^packages\/agent-config-types\/src\/lsp-config\.ts$/,
  /^cli\/src\/tui\/pty\/tui-app-fixture\.tsx$/,
]

const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/
const NON_SOURCE = /\.(test|spec|stories)\.[^/]+$/

const cliSchema = z.object({
  base: z.string().trim().min(1, "--base requires a ref").default("origin/dev"),
  strict: z.boolean().default(false),
  coverageMap: z.string().trim().min(1).optional(),
  plan: z.boolean().optional(),
  head: z.string().trim().min(1).optional(),
  mode: z.enum(["incremental", "full"]).optional(),
  output: z.string().trim().min(1).optional(),
  runPlan: z.string().trim().min(1).optional(),
  shard: z.coerce.number().int().positive().optional(),
  coverage: z.boolean().optional(),
})

function createProgram() {
  return new Command()
    .name("pnpm test:coverage:changed")
    .description("Run scoped Jest coverage for files changed from a base ref.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--base <ref>", "Git ref used to find the merge base.", "origin/dev")
    .option("--strict", "Enforce 90% coverage on the changed files.")
    .option("--plan", "Emit a committed-change Jest test plan without running tests.")
    .option("--head <ref>", "Exact checked-out head for a test plan.")
    .option("--mode <mode>", "Test plan mode: incremental or full.")
    .option("--output <file>", "Also write the machine-readable test plan to this file.")
    .option("--run-plan <file>", "Execute one shard from a persisted test plan.")
    .option("--shard <number>", "One-based test-plan shard to execute.")
    .option("--coverage", "Collect coverage when executing a full-mode test plan.")
    .option(
      "--coverage-map <file>",
      "Check an existing complete coverage map instead of rerunning tests."
    )
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

/** Keep only files Jest would collect coverage for. */
export function filterCoverageTargets(files) {
  return files.filter(
    (file) =>
      SOURCE_EXT.test(file) &&
      !NON_SOURCE.test(file) &&
      COLLECTED_ROOTS.some((re) => re.test(file)) &&
      !EXCLUDED.some((re) => re.test(file))
  )
}

/**
 * Build the Jest CLI arguments for a scoped coverage run. `collectCoverageFrom`
 * accepts one glob string, so multiple files become a `{a,b}` brace group
 * (a single file is passed verbatim — a one-entry brace group is not expanded
 * by micromatch).
 */
export function buildJestArgs(files, { strict = false } = {}) {
  const coverageFrom = files.length === 1 ? files[0] : `{${files.join(",")}}`
  const threshold = strict ? changedFileThresholds(files) : {}
  return [
    "--coverage",
    `--collectCoverageFrom=${coverageFrom}`,
    `--coverageThreshold=${JSON.stringify(threshold)}`,
    "--findRelatedTests",
    ...files,
  ]
}

export function changedFileThresholds(files) {
  return Object.fromEntries(
    files.map((file) => [`./${file}`, { branches: 90, functions: 90, lines: 90, statements: 90 }])
  )
}

export function checkChangedCoverage(map, files, { strict = false, cwd = process.cwd() } = {}) {
  if (!strict) return []
  const covered = new Map(map.files().map((file) => [path.resolve(cwd, file), file]))
  return Object.entries(changedFileThresholds(files)).flatMap(([file, thresholds]) => {
    const exact = covered.get(path.resolve(cwd, file))
    if (!exact) return [`Coverage data for ${file} was not found.`]
    return checkGroup(file, thresholds, map.fileCoverageFor(exact).toSummary())
  })
}

/** Changed files vs the merge-base with `base`, plus untracked files. */
export function listChangedFiles(base, exec = (command, args) => execaSync(command, args).stdout) {
  const run = (command, args) => exec(command, args).trim()
  const mergeBase = run("git", ["merge-base", "HEAD", base])
  const changed = run("git", ["diff", "--name-only", "--diff-filter=d", mergeBase])
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"])
  return [...new Set([...changed.split("\n"), ...untracked.split("\n")])].filter(Boolean)
}

/** Deliberate dependency-update smoke policy. Package-owned tests are added below.
 * Lockfiles and root manifests must not become --findRelatedTests inputs: every
 * suite depends on them. These exercise persistence, SDK wire compatibility,
 * rendering, terminal safety and the shipped provider/tool path instead.
 * This is incremental evidence, not a claim of full dependency compatibility;
 * full scheduled/manual/trunk runs retain the complete Jest inventory.
 */
export const DEPENDENCY_SMOKE_TESTS = [
  "lib/db/messages.test.ts",
  "lib/work-submission/chat-adapter.test.ts",
  "lib/claude/sidecar-wire-contract.test.ts",
  "lib/ai/operations/handlers/ai-sdk-surface.test.ts",
  "components/chat/markdown-renderer.test.tsx",
  "cli/src/tui/markdown/tokenize.test.ts",
  "cli/src/tui/pty/conversation-driver.test.ts",
  "cli/src/cli/coding-loop.bundle.test.ts",
]

const GLOBAL_TEST_INPUT =
  /^(?:jest\.[^/]+|tsconfig(?:\.[^/]+)?\.json|babel\.config\.[^/]+|\.swcrc|patches\/.*|scripts\/test\/jest-timing-sequencer\.cjs)$/
const DEPENDENCY_INPUT =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.npmrc)$/
const TEST_INPUT = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const RELATED_INPUT = /\.(?:[cm]?[jt]sx?|json)$/

/** Job boundaries mirror the independent workspace/runtime checks in test.yml. */
export function classifyCiImpact(changedFiles, mode = "incremental") {
  const all =
    mode === "full" ||
    changedFiles.some((file) =>
      /^(?:\.github\/workflows\/(?:ci|test)\.yml|scripts\/test\/coverage-changed\.mjs)$/.test(file)
    )
  const any = (pattern) => all || changedFiles.some((file) => pattern.test(file))
  const globalJS = any(
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.npmrc|patches\/.*|tsconfig(?:\.[^/]+)?\.json|\.github\/workflows\/(?:ci|test)\.yml)$/
  )
  const globalRust = any(/^(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|\.cargo\/.*)$/)
  const rust =
    globalRust ||
    any(
      /^(?:crates\/|src-tauri\/|scripts\/gates\/.*(?:rust|native|tauri)|metadata\/|cli\/src\/x\/agent-launcher\.ts$|hooks\/(?:builtin-hooks\.lockstep|matcher-conformance)\.json$|cli\/src\/serve\/fixtures\/bridge-frames\.json$)/
    )
  return {
    globalJS,
    globalRust,
    frontend:
      globalJS ||
      any(
        /^(?:(?:app|components|hooks|lib|stores|types|i18n|public|packages|scripts\/build|tests\/e2e|e2e)\/|next\.config\.|playwright\.)/
      ),
    sidecar: globalJS || any(/^(?:sidecar|cli|packages|lib)\//),
    docs: globalJS || any(/^docs\//),
    web: globalJS || any(/^web\//),
    mobile: globalJS || any(/^mobile\/|^lib\/capacitor\/|\.mobile\.tsx?$|^next\.config\./),
    browserExtension:
      globalJS ||
      any(/^(?:browser-extension|packages|tests\/e2e\/browser-extension)\/|^playwright\./),
    rust,
    gateway:
      rust ||
      globalJS ||
      any(
        /^(?:sidecar|packages|lib\/companion|tests\/conformance|scripts\/certify|scripts\/build)\//
      ),
    postgres: globalRust || any(/^crates\/(?:cognia-collab-server|cognia-tenant-auth)\//),
    // diagnostic-server has an independent Cargo.lock; root graph edits do not
    // change its dependencies, while toolchain/compiler config changes do.
    diagnostic: any(/^(?:services\/diagnostic-server\/|\.cargo\/|rust-toolchain(?:\.toml)?$)/),
    productionBuild:
      rust ||
      any(
        /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json|next\.config\.[^/]+|postcss\.config\.[^/]+|\.npmrc$|patches\/|scripts\/build\/)/
      ),
  }
}

/** Resolve a committed diff only; local/untracked files never enter a CI plan.
 * --no-renames makes both the removed and new path explicit so deletion-neighbor
 * and colocated suites remain selected after moves. NUL records preserve spaces.
 */
export function listCommittedChanges(
  base,
  head,
  exec = (command, args) => execaSync(command, args).stdout
) {
  const resolve = (ref) =>
    exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim()
  const resolvedBase = resolve(base)
  const resolvedHead = resolve(head)
  const mergeBase = exec("git", ["merge-base", resolvedBase, resolvedHead]).trim()
  const records = exec("git", [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    mergeBase,
    resolvedHead,
    "--",
  ]).split("\0")
  const changedFiles = [],
    deletedFiles = []
  for (let index = 0; index < records.length - 1; index += 2) {
    const status = records[index],
      file = records[index + 1]
    if (!file) throw new Error("Malformed Git name-status record")
    changedFiles.push(file)
    if (status === "D") deletedFiles.push(file)
  }
  return {
    base: resolvedBase,
    head: resolvedHead,
    mergeBase,
    changedFiles: [...new Set(changedFiles)].sort(),
    deletedFiles: deletedFiles.sort(),
  }
}

/** A removed module is absent from Jest's current dependency graph. Find its
 * literal importers in the base tree, then ask Jest for the surviving importers'
 * consumers in the head graph. Matching quoted module suffixes also includes
 * relative, @/ and workspace-package aliases; false positives add tests safely.
 */
export function findDeletedModuleConsumers(
  deletedFiles,
  mergeBase,
  exec = (command, args) => {
    const result = execaSync(command, args, { reject: false })
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error(result.stderr || "Git importer discovery failed")
    return result.stdout
  }
) {
  const patterns = new Set()
  for (const file of deletedFiles) {
    if (!RELATED_INPUT.test(file) || TEST_INPUT.test(file) || DEPENDENCY_INPUT.test(file)) continue
    const stem = path.posix.basename(file).replace(/\.(?:[cm]?[jt]sx?|json)$/, "")
    const packageName = /^packages\/([^/]+)\//.exec(file)?.[1]
    const names = [
      ...(stem === "index" ? [path.posix.basename(path.posix.dirname(file)), "index"] : [stem]),
      ...(packageName ? [packageName] : []),
    ]
    for (const name of names)
      for (const extension of [
        "",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".mjs",
        ".cjs",
        ".json",
      ])
        for (const quote of ['"', "'", "`"]) {
          patterns.add(`/${name}${extension}${quote}`)
          patterns.add(`${quote}${name}${extension}${quote}`)
        }
  }
  if (patterns.size === 0) return []
  const output = exec("git", [
    "grep",
    "--no-textconv",
    "-l",
    "-z",
    "-F",
    ...[...patterns].flatMap((pattern) => ["-e", pattern]),
    mergeBase,
    "--",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.mts",
    "*.mjs",
    "*.cts",
    "*.cjs",
  ])
  return [
    ...new Set(
      output
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const prefix = `${mergeBase}:`
          if (!entry.startsWith(prefix)) throw new Error("Malformed Git importer record")
          return entry.slice(prefix.length)
        })
    ),
  ].sort()
}

/** Deterministic selection and partitioning, shared by local planning and CI. */
export function buildIncrementalTestPlan({
  mode = "incremental",
  base,
  head,
  mergeBase,
  changedFiles = [],
  deletedFiles = [],
  testFiles,
  relatedTests = [],
  unresolvedDeletedFiles = [],
  maxShards = mode === "full" ? 64 : 8,
  suitesPerShard = 150,
  timingManifest = { version: 1, tests: {} },
  sizes = {},
}) {
  if (!["incremental", "full"].includes(mode)) throw new Error("Unknown test plan mode")
  if (
    !Number.isInteger(maxShards) ||
    maxShards < 1 ||
    !Number.isInteger(suitesPerShard) ||
    suitesPerShard < 1
  )
    throw new Error("Test plan shard limits must be positive integers")
  const inventory = [...new Set(testFiles)].sort()
  const available = new Set(inventory)
  const selected = new Set()
  const selectionReasons = []
  const add = (kind, files, source) => {
    const present = [...new Set(files)].filter((file) => available.has(file)).sort()
    if (present.length === 0) return
    present.forEach((file) => selected.add(file))
    selectionReasons.push({ kind, ...(source ? { source } : {}), testFiles: present })
  }
  const globalChanges = changedFiles.filter((file) => GLOBAL_TEST_INPUT.test(file))
  if (mode === "full" || globalChanges.length > 0) {
    add(mode === "full" ? "full" : "test-configuration", inventory, globalChanges.join(","))
  } else {
    add(
      "changed-test",
      changedFiles.filter((file) => available.has(file))
    )
    add("related", relatedTests)
    // A removed dynamic/registry input may leave no literal importer for
    // Jest to follow. Preserve tests for its owning workspace/subtree rather
    // than claiming that an empty static graph proves it has no consumers.
    for (const file of unresolvedDeletedFiles) {
      const parts = file.split("/")
      const owner =
        ["packages", "services"].includes(parts[0]) && parts.length > 2
          ? parts.slice(0, 2).join("/")
          : parts.length > 1
            ? parts[0]
            : "."
      add(
        "deleted-owner-fallback",
        inventory.filter((test) => owner === "." || test.startsWith(`${owner}/`)),
        file
      )
    }
    for (const file of changedFiles) {
      if (RELATED_INPUT.test(file) && !TEST_INPUT.test(file)) {
        const stem = file.replace(/\.[cm]?[jt]sx?$/, "")
        add(
          "colocated",
          inventory.filter((test) => test.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "") === stem),
          file
        )
      }
      if (deletedFiles.includes(file) && RELATED_INPUT.test(file))
        add(
          "deleted-neighbor",
          inventory.filter((test) => path.posix.dirname(test) === path.posix.dirname(file)),
          file
        )
      if (DEPENDENCY_INPUT.test(file)) {
        const directory = path.posix.dirname(file)
        if (directory === "." || directory === "sidecar")
          add("dependency-smoke", DEPENDENCY_SMOKE_TESTS, file)
        if (directory !== ".")
          add(
            "package-contract",
            inventory.filter((test) => test.startsWith(`${directory}/`)),
            file
          )
      }
    }
  }
  const chosen = [...selected].sort()
  const shardCount =
    chosen.length === 0 ? 0 : Math.min(maxShards, Math.ceil(chosen.length / suitesPerShard))
  const weighted = timingSequencer.estimateTestWeights(
    chosen.map((id) => ({ id, size: sizes[id] ?? 1 })),
    timingManifest
  )
  const shards =
    shardCount === 0
      ? []
      : timingSequencer.balanceWeightedTests(weighted, shardCount).map((shard, index) => ({
          shard: index + 1,
          testFiles: shard.tests.map((test) => test.id).sort(),
        }))
  return {
    version: 1,
    mode,
    base,
    head,
    mergeBase,
    changedFiles: [...new Set(changedFiles)].sort(),
    deletedFiles: [...new Set(deletedFiles)].sort(),
    testFiles: chosen,
    suiteCount: chosen.length,
    shardCount,
    shards,
    matrix: { include: shards.map(({ shard }) => ({ shard, total: shardCount })) },
    impacts: classifyCiImpact(changedFiles, mode),
    selectionReasons,
  }
}

export function buildPlannedJestArgs(plan, shard, { coverage = false } = {}) {
  if (plan.version !== 1 || !["incremental", "full"].includes(plan.mode))
    throw new Error("Unsupported test plan")
  if (coverage && plan.mode !== "full") throw new Error("Coverage is allowed only in full mode")
  const selected = plan.shards.find((entry) => entry.shard === shard)
  if (!selected || selected.testFiles.length === 0) throw new Error(`Unknown shard: ${shard}`)
  const assigned = plan.shards.flatMap((entry) => entry.testFiles).sort()
  if (
    new Set(assigned).size !== assigned.length ||
    JSON.stringify(assigned) !== JSON.stringify([...plan.testFiles].sort())
  )
    throw new Error("Test plan contains missing or duplicate suite assignments")
  if (
    assigned.some(
      (file) => path.isAbsolute(file) || file.startsWith("-") || file.split("/").includes("..")
    )
  )
    throw new Error("Test plan contains a non-repository test path")
  return [
    "--silent",
    "--maxWorkers=2",
    ...(coverage
      ? [
          "--coverage",
          "--coverageDirectory=coverage",
          "--coverageReporters=json",
          "--coverageThreshold={}",
        ]
      : ["--coverage=false"]),
    "--runTestsByPath",
    ...selected.testFiles,
  ]
}

/** Keep incremental matrix jobs bounded even when shared configuration affects
 * the whole inventory. Each fresh Jest parent handles at most 150 suites, so
 * module/result retention cannot accumulate across a thousand-suite shard.
 * Full mode retains one process and one coverage map per matrix shard.
 */
export function runPlannedShard(
  plan,
  shard,
  {
    coverage = false,
    env = process.env,
    run = (args, childEnv) =>
      execaSync(process.execPath, args, {
        stdio: "inherit",
        reject: false,
        env: childEnv,
      }),
  } = {}
) {
  const args = buildPlannedJestArgs(plan, shard, { coverage })
  const pathIndex = args.indexOf("--runTestsByPath")
  const flags = args.slice(0, pathIndex + 1)
  const files = args.slice(pathIndex + 1)
  const batchSize = plan.mode === "incremental" ? 150 : files.length
  const batchCount = Math.ceil(files.length / batchSize)
  const timingPaths = []
  let exitCode = 0
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = Math.floor(offset / batchSize) + 1
    const childEnv = { ...env, JEST_COVERAGE: coverage ? "1" : "0" }
    if (batchCount > 1) {
      const junitName = env.JEST_JUNIT_OUTPUT_NAME || `junit-shard-${shard}.xml`
      childEnv.JEST_JUNIT_OUTPUT_NAME = `${junitName.replace(/\.xml$/, "")}-batch-${batch}.xml`
      if (env.JEST_TIMING_OUTPUT) {
        const parsed = path.parse(env.JEST_TIMING_OUTPUT)
        childEnv.JEST_TIMING_OUTPUT = path.join(
          parsed.dir,
          `${parsed.name}-batch-${batch}${parsed.ext}`
        )
        timingPaths.push(childEnv.JEST_TIMING_OUTPUT)
      }
    }
    const result = run(
      ["node_modules/jest/bin/jest.js", ...flags, ...files.slice(offset, offset + batchSize)],
      childEnv
    )
    // Keep running independent batches after a suite failure, but never turn
    // an earlier failure or signal termination into a successful shard.
    if ((result.exitCode ?? 1) !== 0) exitCode = result.exitCode || 1
  }
  if (timingPaths.length > 0) {
    const manifests = timingPaths
      .filter((file) => existsSync(file))
      .map((file) => timingSequencer.readTimingManifest(file))
    if (manifests.length > 0)
      timingSequencer.writeTimingManifest(
        env.JEST_TIMING_OUTPUT,
        timingSequencer.mergeTimingManifests(manifests)
      )
  }
  return exitCode
}

function listJestTests(inputs) {
  const args = [
    "node_modules/jest/bin/jest.js",
    "--listTests",
    "--json",
    "--runInBand",
    ...(inputs ? ["--findRelatedTests", ...inputs] : []),
  ]
  const result = execaSync(process.execPath, args, { env: { ...process.env, JEST_COVERAGE: "0" } })
  // next/jest prints its chosen tsconfig before Jest's one-line JSON array.
  const files = JSON.parse(result.stdout.trim().split("\n").at(-1))
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string"))
    throw new Error("Invalid Jest test inventory")
  return files.map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
}

function createCommittedPlan(args) {
  if (!args.head) throw new Error("--plan requires --head")
  const changes = listCommittedChanges(args.base, args.head)
  const currentHead = execaSync("git", ["rev-parse", "HEAD"]).stdout.trim()
  if (currentHead !== changes.head)
    throw new Error("Test planning must run at the requested head commit")
  const testFiles = listJestTests()
  if (
    args.mode !== "full" &&
    changes.changedFiles.some(
      (file) => DEPENDENCY_INPUT.test(file) && [".", "sidecar"].includes(path.posix.dirname(file))
    )
  ) {
    const missing = DEPENDENCY_SMOKE_TESTS.filter((file) => !testFiles.includes(file))
    if (missing.length)
      throw new Error(
        `Dependency smoke policy references undiscovered suites: ${missing.join(", ")}`
      )
  }
  const deletedConsumerSet = new Set()
  const unresolvedDeletedFiles = []
  if (args.mode !== "full" && !changes.changedFiles.some((file) => GLOBAL_TEST_INPUT.test(file))) {
    for (const file of changes.deletedFiles) {
      if (!RELATED_INPUT.test(file) || TEST_INPUT.test(file) || DEPENDENCY_INPUT.test(file))
        continue
      const consumers = findDeletedModuleConsumers([file], changes.mergeBase).filter((consumer) =>
        existsSync(consumer)
      )
      consumers.forEach((consumer) => deletedConsumerSet.add(consumer))
      if (consumers.length === 0) unresolvedDeletedFiles.push(file)
    }
  }
  const deletedConsumers = [...deletedConsumerSet].sort()
  const inputs = [
    ...new Set([
      ...changes.changedFiles.filter(
        (file) =>
          RELATED_INPUT.test(file) &&
          !TEST_INPUT.test(file) &&
          !DEPENDENCY_INPUT.test(file) &&
          !GLOBAL_TEST_INPUT.test(file) &&
          !changes.deletedFiles.includes(file)
      ),
      ...deletedConsumers,
    ]),
  ]
  const relatedTests =
    args.mode === "full" ||
    changes.changedFiles.some((file) => GLOBAL_TEST_INPUT.test(file)) ||
    inputs.length === 0
      ? []
      : listJestTests(inputs)
  const sizes = Object.fromEntries(testFiles.map((file) => [file, statSync(file).size]))
  const timingManifest = timingSequencer.readTimingManifest(
    process.env.JEST_TIMING_INPUT || ".cache/jest/timings.json"
  )
  const plan = buildIncrementalTestPlan({
    ...changes,
    mode: args.mode,
    testFiles,
    relatedTests: [...relatedTests, ...deletedConsumers],
    unresolvedDeletedFiles,
    sizes,
    timingManifest,
  })
  return { ...plan, deletedConsumers, unresolvedDeletedFiles }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) return 0
  if (args.plan) {
    const serialized = `${JSON.stringify(createCommittedPlan(args), null, 2)}\n`
    if (args.output) {
      mkdirSync(path.dirname(args.output), { recursive: true })
      writeFileSync(args.output, serialized)
    }
    process.stdout.write(serialized)
    return 0
  }
  if (args.runPlan) {
    const plan = JSON.parse(readFileSync(args.runPlan, "utf8"))
    if (plan.head !== execaSync("git", ["rev-parse", "HEAD"]).stdout.trim())
      throw new Error("Test plan head differs from checkout")
    return runPlannedShard(plan, args.shard, args)
  }
  const targets = filterCoverageTargets(listChangedFiles(args.base))
  if (targets.length === 0) {
    console.log(
      `[coverage-changed] no coverage-collected files changed vs ${args.base} — nothing to do`
    )
    return 0
  }
  console.log(
    `[coverage-changed] ${targets.length} changed file(s) vs ${args.base}:\n` +
      targets.map((f) => `  - ${f}`).join("\n")
  )
  if (args.coverageMap) {
    const errors = checkChangedCoverage(mergeCoverageFiles([args.coverageMap]), targets, args)
    for (const error of errors) console.error(`[coverage-changed] ${error}`)
    return errors.length === 0 ? 0 : 1
  }
  const result = execaSync("pnpm", ["exec", "jest", ...buildJestArgs(targets, args)], {
    stdio: "inherit",
    env: { ...process.env, JEST_COVERAGE: "1" },
    reject: false,
  })
  return result.exitCode ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main())
  } catch (err) {
    console.error(`[coverage-changed] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
