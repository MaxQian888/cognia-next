import {
  RESOURCE_PARAM_KINDS,
  isResourceParamKind,
  resourceOptionFromRef,
  resourceParamValue,
} from "./resource-kinds"
import { listMentionPickHandlers } from "@/lib/chat/mentions/pick-registry"
import type { PopoverItem } from "@/components/chat/composer-popover"

// Minimal stand-ins carrying only the fields `toContextRef` reads. The point of
// the sweep below is WHICH kinds produce a handle, not what the handle says.
const FIXTURES: Record<string, unknown> = {
  file: { kind: "file", entry: { relPath: "src/app.ts", isDir: false } },
  agent: { kind: "agent", target: { name: "reviewer" } },
  subagent: { kind: "subagent", target: { handle: "reviewer", name: "Reviewer" } },
  skill: { kind: "skill", skill: { id: "s1", name: "Skill" } },
  preset: { kind: "preset", preset: { id: "p1", name: "Preset" } },
  doc: { kind: "doc", providerId: "lark", accountId: "a1", doc: { id: "d1", title: "Doc" } },
  entity: {
    kind: "entity",
    candidate: { entityKind: "issue", id: "i1", title: "Issue", searchText: "issue" },
  },
  wfElement: {
    kind: "wfElement",
    element: { type: "node", id: "n1", label: "Node", kind: "agent" },
  },
}

describe("resource parameter kinds", () => {
  // The rule this module exists to hold: a parameter occupies a position in a
  // sentence, so only picks that PRODUCE TEXT at that position can be one.
  // Register a new insertion-style mention and this fails until it is either
  // listed as a parameter kind or deliberately excluded.
  it("is exactly the set of insertion-style mention picks", () => {
    const handlers = listMentionPickHandlers()
    expect(handlers.length).toBeGreaterThan(0)

    const missingFixture = handlers.map((h) => h.kind).filter((kind) => !FIXTURES[kind])
    expect(missingFixture).toEqual([])

    const insertionStyle = handlers
      .filter((h) => h.toContextRef(FIXTURES[h.kind] as Extract<PopoverItem, { kind: never }>))
      .map((h) => h.kind)
      .sort()

    expect(insertionStyle).toEqual([...RESOURCE_PARAM_KINDS].sort())
  })

  it("rejects kinds that are not parameter-eligible", () => {
    expect(isResourceParamKind("file")).toBe(true)
    expect(isResourceParamKind("skill")).toBe(false)
    expect(isResourceParamKind(undefined)).toBe(false)
  })

  it("carries the token the mention would have inserted", () => {
    const option = resourceOptionFromRef({ kind: "file", id: "src/lib", raw: "@src/lib/" })
    expect(option).toEqual({ id: "src/lib", label: "src/lib", raw: "@src/lib/" })
    expect(resourceParamValue("file", option!)).toEqual({
      kind: "resource",
      resourceKind: "file",
      id: "src/lib",
      label: "src/lib",
      raw: "@src/lib/",
    })
  })

  it("falls back to `@id` when a handle carries no raw token", () => {
    expect(resourceOptionFromRef({ kind: "agent", id: "reviewer" })?.raw).toBe("@reviewer")
  })

  it("returns null for chip-style handles", () => {
    expect(resourceOptionFromRef({ kind: "skill", id: "s1" })).toBeNull()
  })
})
