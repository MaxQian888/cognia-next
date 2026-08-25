/**
 * Guest has no producer yet — pinned, so the day it gets one, this fails.
 *
 * ADR-0149 §4 makes a guest a `User` holding Workspace membership WITHOUT Org
 * membership, and Batch 5 makes that state derivable (`resolvePersonStanding`)
 * and visible (the Feishu principals card's standing badge). What it does not
 * have is anything that WRITES a `workspaceMemberships` row in production:
 * the collaboration server owns those rows, and the client has no configured
 * endpoint to pull them from until the Workspace plane lands.
 *
 * So the `guest` badge is currently unreachable outside tests. That is
 * deliberate and recorded in ADR-0149's Batch 5 notes — but "deliberate" rots
 * silently, so this test walks the tree instead of trusting the note. When a
 * producer appears, update the ADR note in the same change that makes this
 * fail.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** Source files that may legitimately call the writer. */
const ALLOWED = [
  // The accessor itself, and its own tests.
  /^lib\/db\/identity\.ts$/,
  // Any test may seed one — the point is production callers.
  /\.test\.tsx?$/,
]

function trackedSources(): string[] {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      "lib/**/*.ts",
      "lib/**/*.tsx",
      "components/**/*.ts",
      "components/**/*.tsx",
      "hooks/**/*.ts",
      "hooks/**/*.tsx",
      "stores/**/*.ts",
      "app/**/*.ts",
      "app/**/*.tsx",
    ],
    { encoding: "utf8", cwd: process.cwd() }
  )
  return output.split("\n").filter(Boolean)
}

describe("workspaceMemberships producers", () => {
  it("has no production writer, so `guest` is not yet reachable", () => {
    const files = trackedSources()
    // A sweep that scanned nothing also passes an emptiness assertion.
    expect(files.length).toBeGreaterThan(500)

    let scanned = 0
    const callers: string[] = []
    for (const file of files) {
      if (ALLOWED.some((pattern) => pattern.test(file))) continue
      scanned += 1
      let source: string
      try {
        source = readFileSync(file, "utf8")
      } catch {
        continue
      }
      if (source.includes("putWorkspaceMembership(")) callers.push(file)
    }

    expect(scanned).toBeGreaterThan(500)
    expect(callers).toEqual([])
  })
})
