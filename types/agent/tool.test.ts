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
import { buildProjectHistoryManifestEntries } from "@/lib/claude/project-history-tool"
import { PET_BUILTIN_PLUGIN_ID, buildPetManifestEntries } from "@/lib/claude/pet-builtin-tools"

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

// Same contract for the project-context deep path: the name in the union and
// the name in the shipped manifest are one fact, so they are compared rather
// than maintained twice.
const DECLARED_PROJECT_HISTORY_TOOLS = [
  "project_history_search",
] as const satisfies readonly BuiltInToolName[]

describe("declared project-history tool names", () => {
  it("match the tool actually shipped in the manifest", () => {
    const shipped = buildProjectHistoryManifestEntries().map((entry) => entry.name)
    expect([...shipped].sort()).toEqual([...DECLARED_PROJECT_HISTORY_TOOLS].sort())
  })
})

// The pet arm, restated the same way. `pet_status` and friends went in with an
// implementation, and this keeps it that way.
const DECLARED_PET_TOOLS = [
  "pet_status",
  "pet_care",
  "pet_say",
  "pet_reward",
  "pet_show",
] as const satisfies readonly BuiltInToolName[]

describe("declared pet tool names", () => {
  it("match the tools actually shipped in the manifest", () => {
    const shipped = buildPetManifestEntries().map((entry) => entry.name)
    expect([...shipped].sort()).toEqual([...DECLARED_PET_TOOLS].sort())
  })

  it("all agree on the plugin id the relay routes them under", () => {
    for (const entry of buildPetManifestEntries()) {
      expect(entry.pluginId).toBe(PET_BUILTIN_PLUGIN_ID)
    }
  })
})
