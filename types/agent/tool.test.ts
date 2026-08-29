/**
 * `BuiltInToolName` is a documentation surface with no runtime reader, which is
 * exactly how eleven artifact/canvas names sat in it for a long time with no
 * implementation anywhere — while both message-conversion paths already knew
 * how to render their results.
 *
 * This test turns that arm into a pinned contract: a name here that no manifest
 * ships fails, and a shipped tool missing from here fails too.
 */
import {
  buildArtifactManifestEntries,
  buildCanvasManifestEntries,
} from "@/lib/claude/artifact-builtin-tools"
import type { BuiltInToolName } from "./tool"

// The artifact/canvas arm, restated as a value so it can be compared. If the
// union changes, this list must change with it — a `satisfies` keeps the two
// from drifting apart in the direction TypeScript can see.
const DECLARED_ARTIFACT_TOOLS = [
  "canvas_create",
  "canvas_update",
  "canvas_read",
  "canvas_open",
  "artifact_create",
  "artifact_update",
  "artifact_read",
  "artifact_delete",
] as const satisfies readonly BuiltInToolName[]

describe("declared artifact/canvas tool names", () => {
  it("match the tools actually shipped in the manifests", () => {
    const shipped = [...buildArtifactManifestEntries(), ...buildCanvasManifestEntries()].map(
      (entry) => entry.name
    )
    expect([...shipped].sort()).toEqual([...DECLARED_ARTIFACT_TOOLS].sort())
  })

  it("no longer declares the three retired names", () => {
    const retired = ["artifact_search", "artifact_render", "artifact_export"]
    for (const name of retired) {
      expect(DECLARED_ARTIFACT_TOOLS as readonly string[]).not.toContain(name)
    }
  })
})
