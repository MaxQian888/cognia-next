import type { CogpackManifestV1, CogpackMember, CogsetRow } from "@/types/plugin/plugin-cogset"

import { cogsetMemberFromCogpack, diffCogpackUpdate, mergeCogpackUpdate } from "./update-diff"

const member = (
  id: string,
  version = "1.0.0",
  extra: Partial<CogpackMember> = {}
): CogpackMember => ({
  id,
  name: id,
  version,
  optional: false,
  source: { kind: "builtin" },
  ...extra,
})

const manifest = (members: CogpackMember[], version = "1.0.0"): CogpackManifestV1 => ({
  schemaVersion: 1,
  kind: "cognia.cogpack",
  id: "writer",
  version,
  name: "Writer",
  compatibility: { minHostVersion: "0.1.0" },
  members,
})

describe("cogsetMemberFromCogpack", () => {
  it("pins the version and carries config and optional", () => {
    expect(
      cogsetMemberFromCogpack(member("a", "2.0.0", { config: { x: 1 }, optional: true }))
    ).toEqual({
      pluginId: "a",
      expectedVersion: "2.0.0",
      config: { x: 1 },
      optional: true,
    })
    expect(cogsetMemberFromCogpack(member("b"))).toEqual({
      pluginId: "b",
      expectedVersion: "1.0.0",
    })
  })
})

describe("diffCogpackUpdate / mergeCogpackUpdate", () => {
  const previous = manifest([
    member("kept"),
    member("bumped"),
    member("reconfigured", "1.0.0", { config: { a: 1 } }),
    member("dropped"),
    member("edited"),
    member("edited-dropped"),
  ])
  const next = manifest(
    [
      member("kept"),
      member("bumped", "1.1.0"),
      member("reconfigured", "1.0.0", { config: { a: 2 } }),
      member("new"),
      member("edited", "2.0.0"),
    ],
    "2.0.0"
  )
  const current: CogsetRow = {
    id: "c",
    name: "Writer",
    members: [
      ...["kept", "bumped", "dropped"].map((id) => cogsetMemberFromCogpack(member(id))),
      cogsetMemberFromCogpack(member("reconfigured", "1.0.0", { config: { a: 1 } })),
      { pluginId: "edited", expectedVersion: "1.0.0", config: { mine: true } },
      { pluginId: "edited-dropped", expectedVersion: "1.0.0", optional: true },
      { pluginId: "local" },
    ],
    source: {
      kind: "cogpack",
      cogpackId: "writer",
      version: "1.0.0",
      fingerprint: "f",
      installId: "i",
    },
    createdAt: 1,
    updatedAt: 1,
  }

  it("classifies every plugin and spots local edits", () => {
    const entries = diffCogpackUpdate(previous, next, current)
    expect(Object.fromEntries(entries.map((e) => [e.pluginId, [e.change, e.localEdited]]))).toEqual(
      {
        bumped: ["repinned", false],
        dropped: ["removed", false],
        edited: ["repinned", true],
        "edited-dropped": ["removed", true],
        kept: ["unchanged", false],
        local: ["local-only", true],
        new: ["added", false],
        reconfigured: ["config-changed", false],
      }
    )
  })

  it("applies upstream changes and keeps local edits unless the user takes the new version", () => {
    const entries = diffCogpackUpdate(previous, next, current)
    const merged = Object.fromEntries(
      mergeCogpackUpdate(entries, new Set()).map((m) => [m.pluginId, m])
    )
    expect(merged.bumped.expectedVersion).toBe("1.1.0")
    expect(merged.reconfigured.config).toEqual({ a: 2 })
    expect(merged.dropped).toBeUndefined()
    expect(merged.edited).toEqual({
      pluginId: "edited",
      expectedVersion: "1.0.0",
      config: { mine: true },
    })
    expect(merged["edited-dropped"]).toEqual(
      current.members.find((m) => m.pluginId === "edited-dropped")
    )
    expect(merged.local).toEqual({ pluginId: "local" })
    // Upstream added it and the user never had it: added.
    expect(merged.new).toEqual({ pluginId: "new", expectedVersion: "1.0.0" })

    const takeNew = Object.fromEntries(
      mergeCogpackUpdate(entries, new Set(["edited", "edited-dropped"])).map((m) => [m.pluginId, m])
    )
    expect(takeNew.edited.expectedVersion).toBe("2.0.0")
    expect(takeNew["edited-dropped"]).toBeUndefined()
    expect(takeNew.new).toEqual({ pluginId: "new", expectedVersion: "1.0.0" })
  })
})
