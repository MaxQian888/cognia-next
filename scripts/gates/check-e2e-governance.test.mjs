import assert from "node:assert/strict"
import { test } from "node:test"

import { auditSource, evaluateFindings } from "./check-e2e-governance.mjs"

test("auditSource flags trust-eroding Playwright patterns but ignores comments", () => {
  const findings = auditSource(
    `
      // test.skip(); page.waitForTimeout(999); expect(true).toBe(true)
      test.only("focused", async ({ page }) => {
        await page.waitForTimeout(100)
        expect(true).toBe(true)
      })
      test.fixme("blocked", async () => {})
      test.describe("feature stub", () => {})
      if (await page.getByRole("button").count()) {
        await page.getByRole("button").click()
      }
    `,
    "tests/e2e/example.spec.ts"
  )

  assert.deepEqual(
    findings.map((finding) => finding.rule),
    [
      "focused-test",
      "arbitrary-timeout",
      "vacuous-assertion",
      "runtime-skip",
      "stub-contract",
      "conditional-locator-guard",
    ]
  )
})

test("evaluateFindings accepts an exact, reviewed debt entry", () => {
  const findings = [
    {
      file: "tests/e2e/example.spec.ts",
      line: 3,
      rule: "runtime-skip",
      message: "blocked",
    },
  ]
  const result = evaluateFindings(
    findings,
    {
      exceptions: [
        {
          file: "tests/e2e/example.spec.ts",
          rule: "runtime-skip",
          occurrences: 1,
          reason: "Requires a native runtime that is unavailable in browser CI.",
          reviewAfter: "2026-12-31",
        },
      ],
    },
    new Date("2026-07-18T00:00:00Z")
  )

  assert.equal(result.violations.length, 0)
  assert.equal(result.accepted.length, 1)
})

test("evaluateFindings rejects new, stale, expired, and count-drift debt", () => {
  const result = evaluateFindings(
    [
      { file: "a.ts", line: 1, rule: "runtime-skip", message: "skip" },
      { file: "b.ts", line: 2, rule: "arbitrary-timeout", message: "wait" },
      { file: "b.ts", line: 3, rule: "arbitrary-timeout", message: "wait" },
    ],
    {
      exceptions: [
        {
          file: "b.ts",
          rule: "arbitrary-timeout",
          occurrences: 1,
          reason: "Legacy gesture synchronization is awaiting an event seam.",
          reviewAfter: "2026-12-31",
        },
        {
          file: "gone.ts",
          rule: "runtime-skip",
          occurrences: 1,
          reason: "The former platform blocker should now have disappeared.",
          reviewAfter: "2026-12-31",
        },
        {
          file: "old.ts",
          rule: "stub-contract",
          occurrences: 1,
          reason: "This behavior was blocked pending its product implementation.",
          reviewAfter: "2026-01-01",
        },
      ],
    },
    new Date("2026-07-18T00:00:00Z")
  )

  assert.deepEqual(
    new Set(result.violations.map((violation) => violation.rule)),
    new Set(["runtime-skip", "exception-count-drift", "stale-exception", "expired-exception"])
  )
})

test("focused, vacuous, and conditional-locator tests can never be exempted", () => {
  for (const rule of ["focused-test", "vacuous-assertion", "conditional-locator-guard"]) {
    const result = evaluateFindings(
      [{ file: "a.ts", line: 1, rule, message: "invalid" }],
      {
        exceptions: [
          {
            file: "a.ts",
            rule,
            occurrences: 1,
            reason: "This intentionally invalid exception must not weaken the gate.",
            reviewAfter: "2026-12-31",
          },
        ],
      },
      new Date("2026-07-18T00:00:00Z")
    )

    assert.ok(result.violations.some((violation) => /cannot be exempted/.test(violation.message)))
  }
})
