/** @jest-environment node */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { scanAllFiles } from "@/scripts/gates/lint-i18n"
import { INTEGRATION_REASON_KEYS, REVIEW_REASON_KEYS } from "./presentation"

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const path = prefix ? `${prefix}.${key}` : key
      return typeof entry === "string"
        ? [[path, entry]]
        : Object.entries(flatten(entry as Record<string, unknown>, path))
    })
  )
}

const messageDir = join(process.cwd(), "i18n/messages")
const en = flatten(JSON.parse(readFileSync(join(messageDir, "en/agentChanges.json"), "utf8")))
const zh = flatten(JSON.parse(readFileSync(join(messageDir, "zh-CN/agentChanges.json"), "utf8")))

it("has no hard-coded user-facing JSX strings in the new components", () => {
  const directory = join(process.cwd(), "components/source-control/agent-changes")
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => join(directory, file))
  expect(scanAllFiles(files, [])).toEqual([])
})

it("keeps both split locales complete and nonempty without generated aggregates", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  for (const messages of [en, zh])
    for (const [key, value] of Object.entries(messages))
      expect({ key, nonempty: value.trim().length > 0 }).toEqual({ key, nonempty: true })
  for (const locale of ["en", "zh-CN"]) {
    const sourceControl = JSON.parse(
      readFileSync(join(messageDir, locale, "sourceControl.json"), "utf8")
    )
    expect(sourceControl.views.agents.trim().length).toBeGreaterThan(0)
  }
})

it("provides every literal and enumerated dynamic translation used by the components", () => {
  const directory = join(process.cwd(), "components/source-control/agent-changes")
  const keys = new Set<string>([
    ...Object.values(REVIEW_REASON_KEYS),
    ...Object.values(INTEGRATION_REASON_KEYS),
    "reasons.reviewPolicyInvalid",
    "reasons.unknown",
    "integrationReasons.unknown",
  ])
  for (const file of readdirSync(directory).filter(
    (file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx")
  )) {
    const source = readFileSync(join(directory, file), "utf8")
    for (const match of source.matchAll(/\bt\("([^"]+)"/g)) keys.add(match[1])
  }
  const dynamic: Record<string, string[]> = {
    states: [
      "draft",
      "ready",
      "approved",
      "changesRequested",
      "queued",
      "integrating",
      "conflicted",
      "failed",
      "merged",
      "rolledBack",
      "abandoned",
    ],
    risk: ["low", "medium", "high"],
    fileStatus: ["added", "modified", "deleted", "renamed", "typeChanged"],
    verdicts: ["approve", "requestChanges", "comment", "unavailable"],
    reviewers: ["agent", "user", "deterministic"],
    severity: ["info", "warning", "critical"],
    checkOutcomes: ["passed", "failed", "inconclusive"],
    gaps: [
      "missingReview",
      "reviewNotApproved",
      "missingCheck",
      "checkNotPassed",
      "missingHumanApproval",
      "staleHead",
    ],
    integrate: ["predictedConflicts", "overlaps"],
    outcomes: ["published", "conflicted", "failed", "blocked"],
    runStates: [
      "planned",
      "preparing",
      "prepared",
      "publishing",
      "published",
      "stale",
      "conflicted",
      "failed",
      "aborted",
      "interrupted",
      "rolledBack",
    ],
    itemOutcomes: ["pending", "merged", "rerereResolved", "conflicted", "skipped", "dropped"],
    errors: ["load", "action"],
  }
  for (const [prefix, values] of Object.entries(dynamic))
    for (const value of values) keys.add(`${prefix}.${value}`)
  for (const key of keys) {
    expect(en[key]).toBeDefined()
    expect(zh[key]).toBeDefined()
  }
})

// next-intl is replaced in jest.setup.ts, so the select is checked by shape;
// `pnpm i18n:build` validates that the message parses.
it("names every host operation in the op log in both locales", () => {
  for (const messages of [en, zh]) {
    const message = messages["runs.operation"]
    expect(message).toMatch(/^\{reason, select, /)
    for (const reason of ["publish", "rollbackSwap", "rollbackRevert", "other"])
      expect({ reason, branch: new RegExp(`[ ,]${reason} \\{[^{}]+\\}`).test(message) }).toEqual({
        reason,
        branch: true,
      })
  }
})
