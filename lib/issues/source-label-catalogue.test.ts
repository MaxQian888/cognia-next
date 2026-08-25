/**
 * Every federated source kind must have a translated label, in both locales.
 *
 * `components/issues/filter-bar/active-filter-chips.tsx` renders the label with
 * a **dynamic** key — ``t(`source.${chip.value}`)`` — and `pnpm lint:i18n`
 * only sees literal keys. So adding a source kind without adding its label
 * passes every gate and ships a filter chip reading `issues.source.collab`.
 *
 * This is the guardrail for that gap: it walks the runtime authority rather
 * than a hand-kept list, so a sixth source kind fails here on the day it is
 * added.
 */

import en from "@/i18n/messages/en/issues.json"
import zh from "@/i18n/messages/zh-CN/issues.json"
import { ISSUE_SOURCE_KINDS } from "@/types/issues/unified"

const catalogues = { en, "zh-CN": zh } as const

describe("issues.source.* label catalogue", () => {
  it.each(Object.keys(catalogues))("%s covers every source kind", (locale) => {
    const source = (
      catalogues[locale as keyof typeof catalogues] as { source: Record<string, string> }
    ).source
    const missing = ISSUE_SOURCE_KINDS.filter(
      (kind) => typeof source[kind] !== "string" || source[kind].trim() === ""
    )
    expect(missing).toEqual([])
  })

  it("gives each kind a distinct label, so two chips are never the same word", () => {
    // `collab` was briefly "Team", which is what `agent-team` already reads as.
    for (const locale of Object.keys(catalogues)) {
      const source = (
        catalogues[locale as keyof typeof catalogues] as { source: Record<string, string> }
      ).source
      const labels = ISSUE_SOURCE_KINDS.map((kind) => source[kind])
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it("keeps the two locales in step on which kinds they cover", () => {
    const keysFor = (catalogue: { source: Record<string, string> }) =>
      ISSUE_SOURCE_KINDS.filter((kind) => kind in catalogue.source).sort()
    expect(keysFor(en as { source: Record<string, string> })).toEqual(
      keysFor(zh as { source: Record<string, string> })
    )
  })
})
