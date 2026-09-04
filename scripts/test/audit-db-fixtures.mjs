#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { execaSync } from "execa"
import { z } from "zod"

const AUTO_INCREMENT_TABLES = [
  "subscriptionUsage",
  "petActivityLog",
  "subscriptionBalance",
  "petConversationV2",
  "chatInputHistory",
  "providerLimits",
]

const FORBIDDEN_RULES = [
  {
    code: "constructs-database",
    reason: "constructs a named CogniaDB instance",
    pattern: /\bnew\s+CogniaDB\s*\(/,
  },
  {
    code: "switches-database",
    reason: "switches or clears the active account database",
    pattern: /\b(?:activateAccountDatabase|clearAccountDatabaseSelection)\s*\(/,
  },
  {
    code: "resets-modules",
    reason: "resets or isolates the Jest module registry",
    pattern: /\bjest\.(?:resetModules|isolateModules|isolateModulesAsync)\s*\(/,
  },
  {
    code: "schema-mode",
    reason: "changes the full-schema test mode",
    pattern: /__COGNIA_DB_FULL_SCHEMA__|COGNIA_DB_FULL_SCHEMA/,
  },
  {
    code: "connection-lifecycle",
    reason: "asserts IndexedDB connection lifecycle behavior",
    pattern: /\b(?:versionchange|deleteDatabase|onblocked)\b|\.on\(\s*["']blocked["']/,
  },
  {
    code: "fake-timers",
    reason: "uses fake timers that can stall fake IndexedDB reopening",
    pattern: /\bjest\.useFakeTimers\s*\(/,
  },
  {
    code: "auto-increment-table",
    reason: "uses a table whose key generator is not reset by clear()",
    pattern: new RegExp(`\\b(?:${AUTO_INCREMENT_TABLES.join("|")})\\b`),
  },
]

const LEGACY_RESET_PATTERN =
  /beforeEach\s*\([\s\S]{0,1600}?getDb\(\)\.delete\(\)[\s\S]{0,800}?__resetDbForTesting\s*\([\s\S]{0,800}?(?:whenSeeded\s*\(|beforeEach\s*\()/

export function analyzeDbTestSource(source) {
  const usesFastFixture = /\bcreateDbTestFixture\b/.test(source)
  const hasLegacyReset = LEGACY_RESET_PATTERN.test(source)
  const forbiddenReasons = FORBIDDEN_RULES.filter((rule) => rule.pattern.test(source)).map(
    ({ code, reason }) => ({ code, reason })
  )

  return { usesFastFixture, hasLegacyReset, forbiddenReasons }
}

export function listFixtureCandidates() {
  const exclusions = loadExclusions()
  return listTestFiles().filter((file) => {
    if (exclusions[file]) return false
    const result = analyzeDbTestSource(readFileSync(file, "utf8"))
    return result.hasLegacyReset && result.forbiddenReasons.length === 0
  })
}

function listTestFiles() {
  const files = execaSync("git", [
    "ls-files",
    "-co",
    "--exclude-standard",
    "--",
    "*.test.ts",
    "*.test.tsx",
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
  return filterExistingTestFiles(files)
}

export function filterExistingTestFiles(files, exists = existsSync) {
  return files.filter((file) => exists(file))
}

function loadExclusions() {
  const url = new URL("./db-fixture-exclusions.json", import.meta.url)
  return JSON.parse(readFileSync(url, "utf8"))
}

function loadBaseline() {
  const url = new URL("./db-fixture-baseline.json", import.meta.url)
  return JSON.parse(readFileSync(url, "utf8"))
}

export function auditResultPasses({ unsafeCount, remainingCount, strict, maxLegacyResets }) {
  if (unsafeCount > 0) return false
  if (strict) return remainingCount === 0
  return remainingCount <= maxLegacyResets
}

export function auditDbFixtures({ strict = false } = {}) {
  const exclusions = loadExclusions()
  const { maxLegacyResets } = loadBaseline()
  const unsafe = []
  const remaining = []
  let adopted = 0
  let matchedExclusions = 0

  for (const file of listTestFiles()) {
    const result = analyzeDbTestSource(readFileSync(file, "utf8"))
    if (result.usesFastFixture) {
      adopted += 1
      if (result.forbiddenReasons.length > 0) unsafe.push({ file, ...result })
    } else if (result.hasLegacyReset) {
      if (exclusions[file]) matchedExclusions += 1
      else remaining.push(file)
    }
  }

  for (const entry of unsafe) {
    const reasons = entry.forbiddenReasons.map((reason) => reason.reason).join("; ")
    console.error(`[db-fixture-audit] unsafe fixture adoption: ${entry.file}: ${reasons}`)
  }
  if (strict) {
    for (const file of remaining) {
      console.error(`[db-fixture-audit] legacy reset remains without exclusion: ${file}`)
    }
  }
  if (!strict && remaining.length > maxLegacyResets) {
    console.error(
      `[db-fixture-audit] legacy reset count regressed: ${remaining.length} > baseline ${maxLegacyResets}`
    )
  }

  console.log(
    `[db-fixture-audit] adopted=${adopted} registeredExclusions=${Object.keys(exclusions).length} matchedExclusions=${matchedExclusions} remaining=${remaining.length} baseline=${maxLegacyResets}`
  )
  return auditResultPasses({
    unsafeCount: unsafe.length,
    remainingCount: remaining.length,
    strict,
    maxLegacyResets,
  })
}

const cliSchema = z
  .object({
    listCandidates: z.boolean().default(false),
    strict: z.boolean().default(false),
  })
  .refine(({ listCandidates, strict }) => !(listCandidates && strict), {
    message: "--list-candidates cannot be combined with other arguments",
  })

function createProgram() {
  return new Command()
    .name("pnpm test:db-fixture:audit")
    .description("Audit database tests for safe fast-fixture adoption.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--strict", "Require zero legacy database reset suites.")
    .option("--list-candidates", "List suites that can adopt the fast fixture.")
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

function main(argv) {
  const args = parseArgs(argv)
  if (!args) return 0
  if (args.listCandidates) {
    for (const file of listFixtureCandidates()) console.log(file)
    return 0
  }
  return auditDbFixtures({ strict: args.strict }) ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`[db-fixture-audit] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
