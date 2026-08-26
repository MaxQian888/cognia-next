/**
 * `workspaceMemberships` has exactly one production writer — ADR-0149 §4.
 *
 * # Why this test exists at all
 *
 * It was written in Batch 5 to pin the OPPOSITE: at that point nothing wrote
 * these rows, so "guest" was a shape the code could describe and nothing could
 * ever be in. The test walked the tree for a writer and asserted there was
 * none, so the claim in the ADR could not rot into a stale comment.
 *
 * Batch 7 gave it one. `lib/collab/sync.ts` writes what the collaboration
 * server says — `pullCollabMemberships` for the caller's own seats, and
 * `pullCollabWorkspaces` for everybody else's, through the accessor's
 * `replaceWorkspaceRoster`. That is what makes a guest reachable, and visible
 * to somebody other than themselves. The test survives, inverted: there must
 * be exactly one writer, and it must be that module.
 *
 * # Why one, and not "at least one"
 *
 * ADR-0149 §6 makes the server authoritative for membership. A second writer
 * would be a second opinion about who belongs where, and the local one would
 * win whenever it ran last — which is how a revoked person keeps their access
 * on one machine. If a second writer is ever right, it should be hard enough
 * to add that somebody has to come here and say why.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** The one module allowed to write a workspace membership. */
const AUTHORIZED_WRITER = "lib/collab/sync.ts"

/** Source files that are not production writers. */
const EXEMPT = [
  // The accessor itself.
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
  it("has exactly one production writer, and it is the collaboration pull", () => {
    const files = trackedSources()
    // A sweep that scanned nothing also passes an emptiness assertion.
    expect(files.length).toBeGreaterThan(500)

    let scanned = 0
    const callers: string[] = []
    for (const file of files) {
      if (EXEMPT.some((pattern) => pattern.test(file))) continue
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
    expect(callers).toEqual([AUTHORIZED_WRITER])
  })
})
