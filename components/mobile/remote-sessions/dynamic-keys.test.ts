/**
 * Catalogue coverage for the mobile session tabs' DYNAMIC translation keys.
 *
 * `lint:i18n` checks literal `t("a.b")` references and skips interpolated
 * ones — there are over 1500 of those in this repo, and all three keys these
 * tabs build (`kinds.*`, `unavailable.*`, `conclusions.*`) are interpolated.
 * A missing entry therefore passes every gate and renders a raw internal
 * identifier such as `noTextDiff` to the user.
 *
 * Each list is typed as its union, so the `never` witness fails the TYPECHECK
 * when a union grows without the list; the runtime assertion then proves the
 * key exists in BOTH locales.
 */

import en from "@/i18n/messages/en/mobile/remoteSessions.json"
import zh from "@/i18n/messages/zh-CN/mobile/remoteSessions.json"

import {
  CHANGE_DIFF_AVAILABILITIES,
  RUN_CHANGE_KINDS,
  type ChangeDiffAvailability,
} from "@/lib/task-workspace/run-changes"
import type { ChangeKind } from "@/lib/task-workspace/types"
import type { RunVerificationConclusion } from "@/types/execution/run"

/** Fails to compile when `Union` has a member `List` does not cover. */
type Covers<Union, List extends readonly Union[]> =
  Exclude<Union, List[number]> extends never ? true : never

const _kinds: Covers<ChangeKind, typeof RUN_CHANGE_KINDS> = true
const _availabilities: Covers<ChangeDiffAvailability, typeof CHANGE_DIFF_AVAILABILITIES> = true

const CONCLUSIONS = ["passed", "failed", "inconclusive"] as const
const _conclusions: Covers<RunVerificationConclusion, typeof CONCLUSIONS> = true

// Reference the compile-time witnesses so lint does not strip them.
void [_kinds, _availabilities, _conclusions]

function expectKeys(
  section: Record<string, unknown>,
  zhSection: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  for (const key of keys) {
    expect([label, key, typeof section[key]]).toEqual([label, key, "string"])
    expect([label, key, typeof zhSection[key]]).toEqual([label, key, "string"])
  }
}

describe("mobile session tab dynamic translation keys", () => {
  it("covers every change kind in both locales", () => {
    expectKeys(en.detail.changes.kinds, zh.detail.changes.kinds, RUN_CHANGE_KINDS, "kinds")
  })

  it("covers every withheld-diff reason in both locales", () => {
    // `available` renders a diff, not a label, so it is the one member with
    // no entry under `unavailable` — asserted explicitly so a future member
    // cannot be dropped by mistaking it for this exemption.
    const reasons = CHANGE_DIFF_AVAILABILITIES.filter((value) => value !== "available")
    expect(reasons).toHaveLength(CHANGE_DIFF_AVAILABILITIES.length - 1)
    expectKeys(
      en.detail.changes.unavailable,
      zh.detail.changes.unavailable,
      reasons,
      "unavailable"
    )
  })

  it("covers every verification conclusion in both locales", () => {
    expectKeys(en.detail.tests.conclusions, zh.detail.tests.conclusions, CONCLUSIONS, "conclusions")
  })

  it("keeps the tab labels present in both locales", () => {
    expectKeys(en.detail.tabs, zh.detail.tabs, ["transcript", "changes", "tests"], "tabs")
  })
})
