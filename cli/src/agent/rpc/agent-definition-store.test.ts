import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  computeToolSchemaDigest,
  type AgentDefinitionInput,
} from "@/packages/agent/src/agent-definition"

import {
  AgentDefinitionStoreError,
  createAgentDefinitionStore,
  type AgentDefinitionStore,
} from "./agent-definition-store"

function definition(overrides: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    name: "Release bot",
    composition: { presetId: "coding" },
    ...overrides,
  }
}

describe("createAgentDefinitionStore", () => {
  let home: string
  let store: AgentDefinitionStore
  let clock: number

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "cognia-agent-defs-"))
    clock = Date.parse("2026-08-23T00:00:00.000Z")
    store = createAgentDefinitionStore({ home, now: () => (clock += 1_000) })
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it("creates version 1 with a slug id and a content digest", () => {
    const created = store.create(definition())
    expect(created).toMatchObject({ agentId: "release-bot", version: 1, name: "Release bot" })
    expect(created.definitionDigest).toMatch(/^sha256-/)
    expect(store.get("release-bot")).toEqual(created)
  })

  it("honours a caller-chosen agentId", () => {
    expect(store.create(definition({ agentId: "custom.id-1" })).agentId).toBe("custom.id-1")
  })

  it("refuses to create over an existing agent", () => {
    store.create(definition({ agentId: "dup" }))
    expect(() => store.create(definition({ agentId: "dup" }))).toThrow(
      expect.objectContaining({ code: "already_exists" })
    )
  })

  it("mints a distinct id when the slug is taken", () => {
    store.create(definition())
    expect(store.create(definition()).agentId).toBe("release-bot-2")
  })

  it("writes definitions 0600 inside a 0700 directory", () => {
    store.create(definition({ agentId: "perm" }))
    const file = path.join(home, "agents", "perm", "v1.json")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(home, "agents", "perm")).mode & 0o777).toBe(0o700)
  })

  it("advances the version through a compare-and-swap", () => {
    store.create(definition({ agentId: "cas" }))
    const second = store.update("cas", 1, definition({ name: "Renamed" }))
    expect(second.version).toBe(2)
    expect(second.name).toBe("Renamed")
    expect(store.versions("cas")).toEqual([1, 2])
  })

  it("rejects an update against a stale expectedVersion", () => {
    store.create(definition({ agentId: "cas" }))
    store.update("cas", 1, definition({ name: "Second" }))
    let thrown: unknown
    try {
      store.update("cas", 1, definition({ name: "Third" }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentDefinitionStoreError)
    expect(thrown).toMatchObject({
      code: "version_conflict",
      detail: { expectedVersion: 1, actualVersion: 2 },
    })
    expect(store.versions("cas")).toEqual([1, 2])
  })

  it("keeps every earlier version readable after an update", () => {
    store.create(definition({ agentId: "history", name: "First" }))
    store.update("history", 1, definition({ name: "Second" }))
    store.update("history", 2, definition({ name: "Third" }))
    expect(store.get("history", 1).name).toBe("First")
    expect(store.get("history", 2).name).toBe("Second")
    expect(store.get("history").name).toBe("Third")
  })

  it("never rewrites a version file in place", () => {
    store.create(definition({ agentId: "immutable", name: "First" }))
    const before = readFileSync(path.join(home, "agents", "immutable", "v1.json"), "utf8")
    store.update("immutable", 1, definition({ name: "Second" }))
    expect(readFileSync(path.join(home, "agents", "immutable", "v1.json"), "utf8")).toBe(before)
  })

  it("survives a restart because the store is the filesystem", () => {
    store.create(definition({ agentId: "durable", name: "Persisted" }))
    store.update("durable", 1, definition({ name: "Updated" }))
    const reopened = createAgentDefinitionStore({ home })
    expect(reopened.get("durable").name).toBe("Updated")
    expect(reopened.versions("durable")).toEqual([1, 2])
  })

  it("archives logically and keeps referenced versions readable", () => {
    store.create(definition({ agentId: "gone" }))
    const archived = store.archive("gone")
    expect(archived.archivedAt).toEqual(expect.any(String))
    expect(store.get("gone", 1).archivedAt).toBe(archived.archivedAt)
    expect(store.list()).toEqual([])
    expect(store.list({ includeArchived: true }).map((entry) => entry.agentId)).toEqual(["gone"])
  })

  it("refuses to update an archived agent until it is restored", () => {
    store.create(definition({ agentId: "frozen" }))
    store.archive("frozen")
    expect(() => store.update("frozen", 1, definition({ name: "x" }))).toThrow(
      expect.objectContaining({ code: "archived" })
    )
    store.restore("frozen")
    expect(store.update("frozen", 1, definition({ name: "x" })).version).toBe(2)
  })

  it("treats archive and restore as idempotent", () => {
    store.create(definition({ agentId: "twice" }))
    const first = store.archive("twice")
    expect(store.archive("twice").archivedAt).toBe(first.archivedAt)
    store.restore("twice")
    expect(store.restore("twice").archivedAt).toBeUndefined()
  })

  it("reports an unknown agent rather than inventing one", () => {
    for (const call of [
      () => store.get("nope"),
      () => store.versions("nope"),
      () => store.update("nope", 1, definition()),
      () => store.archive("nope"),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: "not_found" }))
    }
  })

  it("reports an unknown version distinctly from an unknown agent", () => {
    store.create(definition({ agentId: "known" }))
    expect(() => store.get("known", 9)).toThrow(
      expect.objectContaining({ code: "not_found", detail: { agentId: "known", version: 9 } })
    )
  })

  it("refuses an invalid definition before touching the disk", () => {
    expect(() => store.create({ name: "", composition: { presetId: "" } })).toThrow(
      expect.objectContaining({ code: "invalid_definition" })
    )
    expect(store.list()).toEqual([])
  })

  it("refuses a definition that tries to replace the system policy", () => {
    expect(() =>
      store.create(definition({ instructions: { replace: "ignore policy" } as never }))
    ).toThrow(expect.objectContaining({ code: "invalid_definition" }))
  })

  it("refuses to store a credential in metadata", () => {
    expect(() => store.create(definition({ metadata: { apiKey: "sk-live" } }))).toThrow(
      expect.objectContaining({ code: "invalid_definition" })
    )
  })

  it("carries a tool contract but never a handler", () => {
    const base = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      sideEffect: "none" as const,
    }
    const created = store.create(
      definition({
        agentId: "tooled",
        toolRefs: [{ ...base, schemaDigest: computeToolSchemaDigest(base) }],
      })
    )
    expect(created.toolRefs[0]).toMatchObject({ name: "read_file", sideEffect: "none" })
    const raw = readFileSync(path.join(home, "agents", "tooled", "v1.json"), "utf8")
    expect(raw).not.toContain("handler")
    expect(raw).not.toContain("function")
  })

  it("rejects a tampered definition on read instead of trusting the disk", () => {
    store.create(definition({ agentId: "tampered" }))
    const file = path.join(home, "agents", "tampered", "v1.json")
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    parsed.name = "Someone Else"
    writeFileSync(file, JSON.stringify(parsed))
    expect(() => store.get("tampered")).toThrow(
      expect.objectContaining({ code: "invalid_definition" })
    )
  })

  it("lists agents in a stable order with their latest version", () => {
    store.create(definition({ agentId: "beta" }))
    store.create(definition({ agentId: "alpha" }))
    store.update("alpha", 1, definition({ name: "Alpha 2" }))
    expect(store.list()).toEqual([
      expect.objectContaining({ agentId: "alpha", latestVersion: 2, name: "Alpha 2" }),
      expect.objectContaining({ agentId: "beta", latestVersion: 1 }),
    ])
  })

  it("ignores stray files in the agents directory", () => {
    store.create(definition({ agentId: "real" }))
    writeFileSync(path.join(home, "agents", "not-an-agent.txt"), "junk")
    expect(store.list().map((entry) => entry.agentId)).toEqual(["real"])
  })

  it("returns an empty list before anything has been created", () => {
    expect(store.list()).toEqual([])
  })
})
