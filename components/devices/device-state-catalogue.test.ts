/**
 * Every device grant state and reason must have a label, in both locales.
 *
 * `device-visuals.tsx` renders `t(\`grantState.${state}\`)` and
 * `access-section.tsx` renders `t(\`access.reason.${reasonKey}\`)` — both
 * **dynamic** keys, which `pnpm lint:i18n` does not see. ADR-0149 §5 step two
 * added `suspended` / `ownerMismatch`, and a fifth state added without a label
 * would ship a badge reading `grantState.whatever` and pass every gate.
 *
 * The states are walked from the type's own catalogue rather than a hand-kept
 * list; the reason keys are walked from the source that emits them, so a new
 * `reasonKey:` line fails here on the day it is written.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import en from "@/i18n/messages/en/devices.json"
import zh from "@/i18n/messages/zh-CN/devices.json"

/** Mirrors `DeviceGrantState`; the type is a union, so the values live here. */
const GRANT_STATES = ["granted", "partial", "denied", "unknown", "suspended"] as const

type Catalogue = {
  grantState: Record<string, string>
  access: { reason: Record<string, string> }
}

const catalogues: Record<string, Catalogue> = {
  en: en as unknown as Catalogue,
  "zh-CN": zh as unknown as Catalogue,
}

/** The `reasonKey:` values `buildGrantRows` can actually emit. */
function emittedReasonKeys(): string[] {
  const source = readFileSync(
    join(process.cwd(), "lib", "devices", "grant-capabilities.ts"),
    "utf8"
  )
  const keys = [...source.matchAll(/reasonKey:\s*"([A-Za-z]+)"/g)].map((match) => match[1]!)
  // A sweep that scanned nothing also passes an emptiness assertion.
  expect(keys.length).toBeGreaterThan(0)
  return [...new Set(keys)]
}

describe("devices grant-state catalogue", () => {
  it("keeps the union in step with the type", () => {
    // `DeviceGrantState` is a string union, so it cannot be iterated at
    // runtime. This pins the copy above against the declaration.
    const types = readFileSync(join(process.cwd(), "lib", "devices", "types.ts"), "utf8")
    const declared = types
      .match(/export type DeviceGrantState =([^\n]+)/)![1]!
      .split("|")
      .map((part) => part.trim().replaceAll('"', ""))
      .filter(Boolean)
    expect(declared.sort()).toEqual([...GRANT_STATES].sort())
  })

  it.each(Object.keys(catalogues))("%s labels every grant state", (locale) => {
    const missing = GRANT_STATES.filter(
      (state) => typeof catalogues[locale]!.grantState[state] !== "string"
    )
    expect(missing).toEqual([])
  })

  it.each(Object.keys(catalogues))("%s explains every reason a row can carry", (locale) => {
    const reasons = catalogues[locale]!.access.reason
    const missing = emittedReasonKeys().filter((key) => typeof reasons[key] !== "string")
    expect(missing).toEqual([])
  })

  it("gives each state a distinct label", () => {
    // `suspended` must never read as `denied`: one means "the host is refusing
    // a grant that is still recorded", the other means "there is no grant".
    for (const locale of Object.keys(catalogues)) {
      const labels = GRANT_STATES.map((state) => catalogues[locale]!.grantState[state])
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})
