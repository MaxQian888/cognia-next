#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const AUTO_INCREMENT_TABLES = [
  "subscriptionUsage",
  "petActivityLog",
  "subscriptionBalance",
  "petConversation",
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
    pattern: /\b(?:versionchange|blocked|deleteDatabase)\b/,
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
  return execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "--", "*.test.ts", "*.test.tsx"],
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean)
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

function main() {
  const args = new Set(process.argv.slice(2))
  for (const arg of args) {
    if (arg !== "--strict" && arg !== "--list-candidates") {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (args.has("--list-candidates")) {
    if (args.size > 1) throw new Error("--list-candidates cannot be combined with other arguments")
    for (const file of listFixtureCandidates()) console.log(file)
    return 0
  }
  return auditDbFixtures({ strict: args.has("--strict") }) ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[db-fixture-audit] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
