// Run: node --test .agents/skills/evidence-driven-dev/scripts/ledger.test.mjs
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { checkLedger, openItems, parseLedger, renderTemplate } from "./ledger.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(path.join(HERE, "..", "assets", "ledger-template.md"), "utf8")

const fresh = () =>
  renderTemplate(TEMPLATE, { title: "t", lane: "standard", request: "make it retry", date: "2026-10-21" })

function ledger({ status = "building", knowledge, risks = "", obligations = "", decisions = "", residuals = "", outcomes = "", complexity } = {}) {
  const k =
    knowledge ??
    `| O1 | Long runs stop after ~40 min | Observed | 3 transcripts 2026-10-20 | - |
| H1 | Compaction drops the plan | Hypothesized | - | O1 |
| G1 | Long tasks finish without a human restart | Agreed | user 2026-10-21 | - |`
  const c =
    complexity ??
    ["scale", "technical", "coupling", "requirement", "verification", "risk"]
      .map((d) => `| ${d} | low | fine |`)
      .join("\n")
  return `# Evidence ledger: x

- Status: ${status}
- Lane: standard

## Original request

> make it retry

## Knowledge

| ID | Statement | State | Basis | Depends on |
| --- | --- | --- | --- | --- |
${k}

## Problem frame

Runs lose their plan.

## Complexity profile

| Dimension | Rating | Why / what would resolve it |
| --- | --- | --- |
${c}

## Risks

| ID | Risk (impact) | Severity | Source | Claim | Refuted by |
| --- | --- | --- | --- | --- | --- |
${risks}

## Verification obligations

| ID | Risk | Method | Independence | Evidence | Coverage | Status |
| --- | --- | --- | --- | --- | --- | --- |
${obligations}

## Decisions

| ID | Date | Decision | Action | Based on | Reversal trigger |
| --- | --- | --- | --- | --- | --- |
${decisions}

## Residual risks

| ID | Residual | From | Why still open | Next action | Status |
| --- | --- | --- | --- | --- | --- |
${residuals}

## Outcome

| ID | Signal | How / when measured | Result | Status |
| --- | --- | --- | --- | --- |
${outcomes}
`
}

const check = (text, opts) => checkLedger(parseLedger(text), opts)

test("a freshly rendered template has no errors, only placeholder warnings", () => {
  const { errors, warnings } = check(fresh())
  assert.deepEqual(errors, [])
  assert.ok(warnings.some((w) => w.includes("placeholder")))
})

test("a well-formed building ledger passes", () => {
  const { errors } = check(
    ledger({
      risks: "| R1 | Replay duplicates a tool side effect | high | catalog | resume never re-runs a completed tool | a resumed run re-sends an IM message |",
      obligations: "| V1 | R1 | fault-injection test | tool | `pnpm test -- resume.test.ts` 4 passed | crash after tool result | passed |",
      decisions: "| D1 | 2026-10-21 | checkpoint before retry | spike | O1, H1 | spike shows plan survives compaction |",
    }),
  )
  assert.deepEqual(errors, [])
})

test("high risk without obligation is an error once building", () => {
  const risks = "| R1 | data loss | high | ADR-0215 | no op is lost | an op disappears after merge |"
  assert.ok(check(ledger({ risks })).errors.some((e) => e.includes("R1: high risk has no verification obligation")))
  assert.ok(check(ledger({ status: "exploring", risks })).warnings.some((w) => w.includes("R1: high risk")))
})

test("verified item depending on an invalidated one is stale", () => {
  const knowledge = `| H1 | network drops | Invalidated | logs show no socket errors | - |
| A1 | retry fixes it | Verified | test run | H1 |`
  const { errors } = check(ledger({ knowledge }))
  assert.ok(errors.some((e) => e.includes("A1 is Verified but depends on Invalidated H1")))
})

test("committing on a hypothesis warns; resting on an invalidated item errors", () => {
  const knowledge = `| H1 | compaction drops plan | Hypothesized | - | - |
| H2 | network drops | Invalidated | no socket errors | - |`
  const result = check(
    ledger({
      knowledge,
      decisions: `| D1 | 2026-10-21 | build checkpointing | implement | H1 | - |
| D2 | 2026-10-21 | build retry | implement | H2 | - |`,
    }),
  )
  assert.ok(result.warnings.some((w) => w.includes("D1 commits (implement) on Hypothesized H1")))
  assert.ok(result.errors.some((e) => e.includes("D2 rests on Invalidated H2")))
})

test("passed obligations need real evidence, not predictions", () => {
  const risks = "| R1 | x | medium | catalog | y | z |"
  const { errors } = check(
    ledger({
      risks,
      obligations: `| V1 | R1 | unit test | tool | - | - | passed |
| V2 | R1 | unit test | tool | should pass | all | passed |`,
    }),
  )
  assert.ok(errors.some((e) => e.includes("V1: passed without Evidence")))
  assert.ok(errors.some((e) => e.includes("V2: Evidence")))
})

test("verifying requires non-passed obligations to be carried as residuals", () => {
  const risks = "| R1 | x | high | catalog | y | z |"
  const obligations = "| V1 | R1 | desktop smoke | real-env | - | - | planned |"
  const outcomes = "| M1 | runs finish | next week's runs | - | pending |"
  const bad = check(ledger({ status: "verifying", risks, obligations, outcomes }))
  assert.ok(bad.errors.some((e) => e.includes("V1 is planned")))
  const good = check(
    ledger({
      status: "verifying",
      risks,
      obligations,
      outcomes,
      residuals: "| X1 | desktop smoke not run | V1 | disk full | run tauri-smoke | open |",
    }),
  )
  assert.deepEqual(good.errors, [])
})

test("closed forbids open residuals and uncarried pending outcomes", () => {
  const { errors } = check(
    ledger({
      status: "closed",
      residuals: "| X1 | smoke pending | - | no box | run it | open |",
      outcomes: "| M1 | runs finish | telemetry | - | pending |",
    }),
  )
  assert.ok(errors.some((e) => e.includes("X1 is still open")))
  assert.ok(errors.some((e) => e.includes("M1 outcome is pending")))
})

test("unknown complexity must say what resolves it; missing dimensions error", () => {
  const complexity = `| scale | unknown | - |
| technical | low | ok |`
  const { errors } = check(ledger({ complexity }))
  assert.ok(errors.some((e) => e.includes('"scale" is unknown')))
  assert.ok(errors.some((e) => e.includes('missing dimension "coupling"')))
})

test("unknown references, bad prefixes and duplicates are errors", () => {
  const { errors } = check(
    ledger({
      risks: "| R1 | x | low | catalog | y | - |\n| R1 | x | low | catalog | y | - |",
      decisions: "| Z1 | 2026-10-21 | x | implement | Q9 | - |",
    }),
  )
  assert.ok(errors.some((e) => e.includes("Duplicate ID R1")))
  assert.ok(errors.some((e) => e.includes('ID "Z1"')))
})

test("open lists unresolved questions, obligations, residuals and pending outcomes", () => {
  const { items } = openItems(
    parseLedger(
      ledger({
        status: "verifying",
        knowledge: "| Q1 | does iOS keep the socket? | Open | - | - |",
        risks: "| R1 | x | low | catalog | y | - |",
        obligations: "| V1 | R1 | phone smoke | real-env | - | - | blocked |",
        residuals: "| X1 | phone smoke | V1 | no device | adb run | open |",
        outcomes: "| M1 | fewer restarts | a week of use | - | pending |",
      }),
    ),
  )
  assert.equal(items.length, 4)
  assert.ok(items[0].startsWith("Q1 [Open]"))
})

test("escaped pipes stay inside a cell", () => {
  const parsed = parseLedger(ledger({ risks: "| R1 | a \\| b | low | catalog | y | - |" }))
  assert.equal(parsed.tables.Risks.rows[0][1], "a | b")
})
