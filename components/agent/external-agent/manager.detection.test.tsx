/**
 * @jest-environment jsdom
 *
 * The dynamic-key half of the manager's runtime messaging.
 *
 * `lint:i18n` reads literal `t("...")` calls and cannot see through
 * ``t(`processPlaneWarning.${key}`)``, so a reason code with no translation
 * would ship and render as its own key id. This suite is the check that
 * template literal does not get: every reason the process plane can return has
 * a message in BOTH catalogues, and the table that maps them is exhaustive.
 */

import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"
import type { ProcessPlaneUnavailableReason } from "@/lib/ai/agent/external/process-plane"

import { PLANE_WARNING_KEYS } from "./manager"

const REASONS: ProcessPlaneUnavailableReason[] = [
  "no-host",
  "manifest-missing",
  "unsupported",
  "not-granted",
]

function warnings(bundle: typeof en): Record<string, string> {
  const manager = (bundle.externalAgent as unknown as Record<string, unknown>).manager as Record<
    string,
    unknown
  >
  return manager.processPlaneWarning as Record<string, string>
}

describe("process-plane warning messages", () => {
  it("maps every reason the plane can return", () => {
    // Exhaustive rather than partial: a new reason with no entry would resolve
    // to `processPlaneWarning.undefined` and print that string to a user.
    expect(Object.keys(PLANE_WARNING_KEYS).sort()).toEqual([...REASONS].sort())
  })

  it("has a message for each mapped key in both locales", () => {
    for (const locale of [en, zh]) {
      const catalogue = warnings(locale)
      for (const reason of REASONS) {
        const key = PLANE_WARNING_KEYS[reason]
        expect(typeof catalogue[key]).toBe("string")
        expect(catalogue[key].length).toBeGreaterThan(0)
      }
    }
  })

  it("keeps the two locales in step, with no key on only one side", () => {
    expect(Object.keys(warnings(en)).sort()).toEqual(Object.keys(warnings(zh)).sort())
  })

  it("says something different for each reason", () => {
    // Four identical sentences would pass every check above while telling the
    // user nothing about which of the four situations they are in.
    const messages = REASONS.map((reason) => warnings(en)[PLANE_WARNING_KEYS[reason]])
    expect(new Set(messages).size).toBe(REASONS.length)
  })
})
