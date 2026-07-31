#!/usr/bin/env node

/**
 * Static governance gate for Playwright E2E sources.
 *
 * The gate deliberately audits source structure instead of test results: a
 * skipped or vacuous test can make a green run less trustworthy. Existing,
 * understood debt lives in a reviewed exception ledger with an exact count
 * and a review date. New debt therefore fails immediately, while removing an
 * occurrence also requires deleting or shrinking its stale exception.
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "@babel/parser"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "../..")

export const DEFAULT_E2E_ROOT = join(REPO_ROOT, "tests/e2e")
export const DEFAULT_EXCEPTION_FILE = join(REPO_ROOT, "scripts/e2e/governance-exceptions.json")

const AUDITED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"])
const REQUIRED_ACTION_METHODS = new Set([
  "check",
  "click",
  "dblclick",
  "fill",
  "press",
  "selectOption",
  "setInputFiles",
  "tap",
  "uncheck",
])
const NON_EXEMPT_RULES = new Set([
  "focused-test",
  "vacuous-assertion",
  "conditional-locator-guard",
  "direct-playwright-import",
])

function memberName(node) {
  if (!node || node.type !== "MemberExpression") return null
  if (!node.computed && node.property.type === "Identifier") return node.property.name
  if (node.computed && node.property.type === "StringLiteral") return node.property.value
  return null
}

function isTestObject(node) {
  if (node?.type === "Identifier" && node.name === "test") return true
  return (
    node?.type === "MemberExpression" &&
    memberName(node) === "describe" &&
    node.object.type === "Identifier" &&
    node.object.name === "test"
  )
}

function isTestCall(node, property) {
  return (
    node?.type === "MemberExpression" && memberName(node) === property && isTestObject(node.object)
  )
}

function isBooleanLiteral(node, value) {
  return node?.type === "BooleanLiteral" && node.value === value
}

function isVacuousTrueAssertion(node) {
  if (node.type !== "CallExpression" || memberName(node.callee) !== "toBe") return false
  if (!isBooleanLiteral(node.arguments[0], true)) return false
  const expectCall = node.callee.object
  return (
    expectCall?.type === "CallExpression" &&
    expectCall.callee.type === "Identifier" &&
    expectCall.callee.name === "expect" &&
    isBooleanLiteral(expectCall.arguments[0], true)
  )
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return
  if (typeof node.type === "string") visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit)
    } else {
      walk(value, visit)
    }
  }
}

function addFinding(findings, file, node, rule, message) {
  findings.push({ file, line: node.loc?.start.line ?? 1, rule, message })
}

export function auditSource(source, file = "unknown.ts") {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript", "decorators-legacy", "importAttributes"],
  })
  const findings = []
  const normalizedFile = file.replaceAll("\\", "/")
  const requiresSharedFixture =
    normalizedFile.endsWith(".spec.ts") && !normalizedFile.startsWith("tests/e2e/tauri/")

  walk(ast, (node) => {
    if (
      requiresSharedFixture &&
      node.type === "ImportDeclaration" &&
      node.source.value === "@playwright/test"
    ) {
      addFinding(
        findings,
        file,
        node,
        "direct-playwright-import",
        "Browser specs must import the shared E2E fixture so failures include redacted diagnostics"
      )
    }

    if (node.type === "IfStatement") {
      let guardsOnLocatorCount = false
      let conditionallyRunsAction = false
      walk(node.test, (testNode) => {
        if (
          testNode.type === "CallExpression" &&
          memberName(testNode.callee) === "count" &&
          testNode.callee.object.type !== "Super"
        ) {
          guardsOnLocatorCount = true
        }
      })
      walk(node.consequent, (consequentNode) => {
        if (
          consequentNode.type === "CallExpression" &&
          REQUIRED_ACTION_METHODS.has(memberName(consequentNode.callee))
        ) {
          conditionallyRunsAction = true
        }
      })
      if (guardsOnLocatorCount && conditionallyRunsAction) {
        addFinding(
          findings,
          file,
          node,
          "conditional-locator-guard",
          "Do not make a required E2E behavior optional by branching on locator.count()"
        )
      }
    }

    if (node.type !== "CallExpression") return

    if (isTestCall(node.callee, "only")) {
      addFinding(findings, file, node, "focused-test", "Focused tests must never be committed")
    }

    if (isTestCall(node.callee, "skip") || isTestCall(node.callee, "fixme")) {
      addFinding(
        findings,
        file,
        node,
        "runtime-skip",
        "Skipped/fixme tests require an explicit debt-ledger exception"
      )
    }

    if (memberName(node.callee) === "waitForTimeout") {
      addFinding(
        findings,
        file,
        node,
        "arbitrary-timeout",
        "Use an observable state/event wait; timing debt requires an exception"
      )
    }

    if (isVacuousTrueAssertion(node)) {
      addFinding(
        findings,
        file,
        node,
        "vacuous-assertion",
        "expect(true).toBe(true) cannot prove product behavior"
      )
    }

    const isDescribe =
      node.callee.type === "MemberExpression" &&
      memberName(node.callee) === "describe" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "test"
    const title = node.arguments[0]
    if (isDescribe && title?.type === "StringLiteral" && /\bstub\b/i.test(title.value)) {
      addFinding(
        findings,
        file,
        node,
        "stub-contract",
        "A stub suite is coverage debt and must be tracked until the behavior is executable"
      )
    }
  })

  return findings
}

function collectSources(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) files.push(...collectSources(full))
    else if (entry.isFile() && AUDITED_EXTENSIONS.has(extname(entry.name))) files.push(full)
  }
  return files.sort()
}

export function auditTree(root = DEFAULT_E2E_ROOT, repoRoot = REPO_ROOT) {
  return collectSources(root).flatMap((full) => {
    const file = relative(repoRoot, full).replaceAll("\\", "/")
    return auditSource(readFileSync(full, "utf8"), file)
  })
}

function exceptionKey(item) {
  return `${item.rule}\0${item.file}`
}

export function evaluateFindings(findings, ledger, today = new Date()) {
  const violations = []
  const exceptions = ledger?.exceptions
  if (!Array.isArray(exceptions)) {
    return {
      accepted: [],
      violations: [
        {
          file: "scripts/e2e/governance-exceptions.json",
          line: 1,
          rule: "invalid-ledger",
          message: "Ledger must contain an exceptions array",
        },
      ],
    }
  }

  const byKey = new Map()
  for (const item of exceptions) {
    const key = exceptionKey(item)
    if (byKey.has(key)) {
      violations.push({
        file: item.file,
        line: 1,
        rule: "invalid-ledger",
        message: `Duplicate exception for ${item.rule}`,
      })
      continue
    }
    byKey.set(key, item)

    if (NON_EXEMPT_RULES.has(item.rule)) {
      violations.push({
        file: item.file,
        line: 1,
        rule: "invalid-ledger",
        message: `${item.rule} cannot be exempted`,
      })
    }
    if (!Number.isInteger(item.occurrences) || item.occurrences < 1) {
      violations.push({
        file: item.file,
        line: 1,
        rule: "invalid-ledger",
        message: "Exception occurrences must be a positive integer",
      })
    }
    if (typeof item.reason !== "string" || item.reason.trim().length < 20) {
      violations.push({
        file: item.file,
        line: 1,
        rule: "invalid-ledger",
        message: "Exception reason must explain the concrete blocker",
      })
    }
    const reviewDate = new Date(`${item.reviewAfter}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.reviewAfter ?? "") || Number.isNaN(reviewDate.valueOf())) {
      violations.push({
        file: item.file,
        line: 1,
        rule: "invalid-ledger",
        message: "Exception reviewAfter must be an ISO date",
      })
    } else if (reviewDate < today) {
      violations.push({
        file: item.file,
        line: 1,
        rule: "expired-exception",
        message: `${item.rule} exception was due for review on ${item.reviewAfter}`,
      })
    }
  }

  const findingsByKey = new Map()
  for (const finding of findings) {
    const key = exceptionKey(finding)
    const group = findingsByKey.get(key) ?? []
    group.push(finding)
    findingsByKey.set(key, group)
  }

  const accepted = []
  for (const [key, group] of findingsByKey) {
    const exception = byKey.get(key)
    if (!exception) {
      violations.push(...group)
      continue
    }
    if (group.length !== exception.occurrences) {
      violations.push({
        ...group[0],
        rule: "exception-count-drift",
        message: `${exception.rule} ledger expects ${exception.occurrences} occurrence(s), found ${group.length}`,
      })
      continue
    }
    accepted.push(...group)
  }

  for (const [key, exception] of byKey) {
    if (!findingsByKey.has(key)) {
      violations.push({
        file: exception.file,
        line: 1,
        rule: "stale-exception",
        message: `${exception.rule} debt is gone; remove its ledger entry`,
      })
    }
  }

  return { accepted, violations }
}

function main() {
  const findings = auditTree()
  const ledger = JSON.parse(readFileSync(DEFAULT_EXCEPTION_FILE, "utf8"))
  const { accepted, violations } = evaluateFindings(findings, ledger)

  if (violations.length) {
    process.stderr.write(`E2E governance FAILED — ${violations.length} violation(s)\n`)
    for (const item of violations) {
      process.stderr.write(`  ${item.file}:${item.line} [${item.rule}] ${item.message}\n`)
    }
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `E2E governance passed — ${findings.length - accepted.length} clean finding(s), ` +
      `${accepted.length} tracked debt occurrence(s)\n`
  )
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-e2e-governance.mjs")
) {
  main()
}
