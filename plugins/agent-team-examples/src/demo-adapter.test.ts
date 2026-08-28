/**
 * Contract test for the reference shared-memory adapter. Exercises the full
 * `PluginSharedMemoryAdapterDef` surface the orchestrator drives (write /
 * read / listChanges / delete / clear), plus the team scoping the mirror
 * relies on — two teams selecting the same adapter must never see each
 * other's entries.
 */

import { demoSharedMemoryAdapter, __resetDemoAdapterForTesting } from "./demo-adapter"
import type { SharedMemoryEntry } from "@cognia/plugin-sdk"
const TEAM = "team-1"
const OTHER = "team-2"

function entry(key: string, version: number, value: unknown = `v-${key}`): SharedMemoryEntry {
  return {
    key,
    value,
    writtenBy: "teammate-1",
    writerName: "Coder",
    writtenAt: new Date("2026-01-01T00:00:00Z"),
    version,
  }
}

describe("demoSharedMemoryAdapter", () => {
  beforeEach(() => {
    __resetDemoAdapterForTesting()
  })

  it("declares the identity the manifest contributes", () => {
    expect(demoSharedMemoryAdapter.id).toBe("cognia-agent-team-examples:in-memory")
    expect(demoSharedMemoryAdapter.name).toBeTruthy()
  })

  it("round-trips a written entry", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("plan", 1))
    expect(await demoSharedMemoryAdapter.read(TEAM, "plan")).toMatchObject({
      key: "plan",
      value: "v-plan",
      version: 1,
    })
  })

  it("returns undefined for an unknown key and an unknown team", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("plan", 1))
    expect(await demoSharedMemoryAdapter.read(TEAM, "missing")).toBeUndefined()
    expect(await demoSharedMemoryAdapter.read("no-such-team", "plan")).toBeUndefined()
  })

  it("overwrites in place on a repeated key", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("plan", 1, "first"))
    await demoSharedMemoryAdapter.write(TEAM, entry("plan", 2, "second"))
    expect(await demoSharedMemoryAdapter.read(TEAM, "plan")).toMatchObject({
      value: "second",
      version: 2,
    })
    const { entries } = await demoSharedMemoryAdapter.listChanges(TEAM)
    expect(entries).toHaveLength(1)
  })

  it("scopes entries per team", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("plan", 1, "mine"))
    await demoSharedMemoryAdapter.write(OTHER, entry("plan", 1, "theirs"))
    expect(await demoSharedMemoryAdapter.read(TEAM, "plan")).toMatchObject({ value: "mine" })
    expect(await demoSharedMemoryAdapter.read(OTHER, "plan")).toMatchObject({ value: "theirs" })
  })

  it("lists every entry and reports the max version as the cursor", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("a", 1))
    await demoSharedMemoryAdapter.write(TEAM, entry("b", 4))
    const { entries, cursor } = await demoSharedMemoryAdapter.listChanges(TEAM)
    expect(entries.map((e) => e.key).sort()).toEqual(["a", "b"])
    expect(cursor).toBe(4)
  })

  it("filters to entries newer than the cursor on an incremental pull", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("a", 1))
    await demoSharedMemoryAdapter.write(TEAM, entry("b", 4))
    const { entries, cursor } = await demoSharedMemoryAdapter.listChanges(TEAM, 1)
    expect(entries.map((e) => e.key)).toEqual(["b"])
    expect(cursor).toBe(4)
  })

  it("holds the cursor steady when nothing is newer", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("a", 1))
    const { entries, cursor } = await demoSharedMemoryAdapter.listChanges(TEAM, 7)
    expect(entries).toEqual([])
    expect(cursor).toBe(7)
  })

  it("returns an empty change set for a team that never wrote", async () => {
    const { entries, cursor } = await demoSharedMemoryAdapter.listChanges("fresh-team")
    expect(entries).toEqual([])
    expect(cursor).toBe(0)
  })

  it("deletes one key without touching its siblings", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("a", 1))
    await demoSharedMemoryAdapter.write(TEAM, entry("b", 2))
    await demoSharedMemoryAdapter.delete(TEAM, "a")
    expect(await demoSharedMemoryAdapter.read(TEAM, "a")).toBeUndefined()
    expect(await demoSharedMemoryAdapter.read(TEAM, "b")).toBeDefined()
  })

  it("clears one team and leaves the others intact", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("a", 1))
    await demoSharedMemoryAdapter.write(OTHER, entry("a", 1))
    await demoSharedMemoryAdapter.clear?.(TEAM)
    expect(await demoSharedMemoryAdapter.read(TEAM, "a")).toBeUndefined()
    expect(await demoSharedMemoryAdapter.read(OTHER, "a")).toBeDefined()
  })

  it("wipes every team through the test reset helper", async () => {
    await demoSharedMemoryAdapter.write(TEAM, entry("a", 1))
    await demoSharedMemoryAdapter.write(OTHER, entry("a", 1))
    __resetDemoAdapterForTesting()
    expect(await demoSharedMemoryAdapter.read(TEAM, "a")).toBeUndefined()
    expect(await demoSharedMemoryAdapter.read(OTHER, "a")).toBeUndefined()
  })
})
