/**
 * Dormancy pin (ADR-0043 Phase 12, test axis).
 *
 * `AutoRouterSettings.routingMode`, `allowOverride`, and `customTierModels`
 * are persisted for backward compatibility and read by nothing — the doc
 * comments on each field (type axis) say what replaced them. This test is the
 * third axis: it reads the routing engine's source and the send path and
 * fails the moment any of the three identifiers re-enters a reader.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

const DORMANT_IDENTIFIERS = ["customTierModels", "routingMode", "allowOverride"] as const

/** All non-test .ts sources under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourcesUnder(path))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path)
    }
  }
  return out
}

const SCANNED_FILES = [
  ...sourcesUnder(resolve(__dirname, "../../provider-routing/src")),
  resolve(__dirname, "../../../lib/claude/build-options.ts"),
]

describe("dormant AutoRouterSettings fields", () => {
  it("scans a non-trivial set of routing sources", () => {
    // Guard against the pin silently vacating if the tree layout moves.
    expect(SCANNED_FILES.length).toBeGreaterThan(10)
  })

  for (const identifier of DORMANT_IDENTIFIERS) {
    it(`keeps "${identifier}" out of the routing engine and send path`, () => {
      const offenders = SCANNED_FILES.filter((file) =>
        readFileSync(file, "utf8").includes(identifier)
      )
      expect(offenders).toEqual([])
    })
  }
})
