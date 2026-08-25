/**
 * Every `PersonStanding` must have a translated label, in both locales.
 *
 * `lark-principals.tsx` renders it with a **dynamic** key —
 * ``t(`standing.${…}`)`` — and `pnpm lint:i18n` only sees literal keys. A
 * fourth standing would therefore ship a badge reading
 * `standing.something` and pass every gate.
 *
 * The list is walked from the runtime authority rather than a hand-kept copy,
 * so adding a standing fails here on the day it is added.
 */

import en from "@/i18n/messages/en/settings/connections.json"
import zh from "@/i18n/messages/zh-CN/settings/connections.json"
import { PERSON_STANDINGS } from "@/types/identity"

type Catalogue = { lark: { principals: { standing: Record<string, string> } } }

const catalogues: Record<string, Catalogue> = {
  en: en as unknown as Catalogue,
  "zh-CN": zh as unknown as Catalogue,
}

describe("settings.connections.lark.principals.standing.* catalogue", () => {
  it.each(Object.keys(catalogues))("%s covers every standing", (locale) => {
    const standing = catalogues[locale]!.lark.principals.standing
    const missing = PERSON_STANDINGS.filter(
      (value) => typeof standing[value] !== "string" || standing[value]!.trim() === ""
    )
    expect(missing).toEqual([])
  })

  it("gives each standing a distinct label", () => {
    // "Guest" and "Not a member" are different grants and must never collapse
    // into one word — the badge is the only thing separating "can reach the
    // agent" from "is a member of something".
    for (const locale of Object.keys(catalogues)) {
      const standing = catalogues[locale]!.lark.principals.standing
      const labels = PERSON_STANDINGS.map((value) => standing[value])
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it("keeps the two locales in step on which standings they cover", () => {
    const keysFor = (catalogue: Catalogue) =>
      PERSON_STANDINGS.filter((value) => value in catalogue.lark.principals.standing).sort()
    expect(keysFor(catalogues.en!)).toEqual(keysFor(catalogues["zh-CN"]!))
  })
})
