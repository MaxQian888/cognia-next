/**
 * Every `CollabSkipReason` must have a sentence, in both locales.
 *
 * `collaboration-card.tsx` renders it with a **dynamic** key —
 * ``t(`skipped.${status.reason}`)`` — and `pnpm lint:i18n` only sees literal
 * keys, so a fourth reason would ship a line reading `skipped.whatever` and
 * pass every gate.
 *
 * The list is read from the type's own declaration rather than a hand-kept
 * copy, so adding a reason fails here on the day it is added.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import en from "@/i18n/messages/en/mobile/companion.json"
import zh from "@/i18n/messages/zh-CN/mobile/companion.json"

type Catalogue = { collaboration: { skipped: Record<string, string> } }

const catalogues: Record<string, Catalogue> = {
  en: en as unknown as Catalogue,
  "zh-CN": zh as unknown as Catalogue,
}

/** `CollabSkipReason` is a string union, so it cannot be iterated at runtime. */
function declaredReasons(): string[] {
  const source = readFileSync(join(process.cwd(), "lib", "collab", "refresh.ts"), "utf8")
  const block = source.split("export type CollabSkipReason =")[1]?.split("export type")[0] ?? ""
  const reasons = [...block.matchAll(/\|\s*"([a-z-]+)"/g)].map((match) => match[1]!)
  // A sweep that parsed nothing also passes an emptiness assertion.
  expect(reasons.length).toBeGreaterThanOrEqual(3)
  return reasons
}

describe("collaboration skip-reason catalogue", () => {
  it.each(Object.keys(catalogues))("%s explains every reason", (locale) => {
    const skipped = catalogues[locale]!.collaboration.skipped
    const missing = declaredReasons().filter((reason) => typeof skipped[reason] !== "string")
    expect(missing).toEqual([])
  })

  it("gives each reason a distinct sentence", () => {
    // "No server configured" and "not signed in" send somebody to different
    // places; collapsing them into one line sends them to the wrong one.
    for (const locale of Object.keys(catalogues)) {
      const skipped = catalogues[locale]!.collaboration.skipped
      const lines = declaredReasons().map((reason) => skipped[reason])
      expect(new Set(lines).size).toBe(lines.length)
    }
  })
})
