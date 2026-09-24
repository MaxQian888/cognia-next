import type { Character, ChatSession, Team } from "@cognia/agent-config-types"

import { avatarColor } from "@/lib/ui/avatar"
import { createRowDecorations, type RowDecorationSources } from "./row-decorations"

const alice = { id: "c1", name: "Alice", model: "claude-a", providerId: "anthropic" } as Character
const bob = { id: "c2", name: "Bob", avatarEmoji: "🐙", avatarColor: "#123456" } as Character
const squad = { id: "t1", name: "Squad", avatarEmoji: "🧠" } as Team

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...overrides } as ChatSession
}

function sources(overrides: Partial<RowDecorationSources> = {}): RowDecorationSources {
  return {
    characterById: new Map([
      [alice.id, alice],
      [bob.id, bob],
    ]),
    teamById: new Map([[squad.id, squad]]),
    workspaceNameById: new Map([["w1", "Alpha"]]),
    metadataFields: ["agent", "model", "provider", "workspace"],
    showCustomIcons: true,
    merged: false,
    defaultModel: undefined,
    defaultProvider: undefined,
    fallbackModel: "built-in-model",
    fallbackProvider: "built-in-provider",
    labelModel: (id) => `Model ${id}`,
    labelProvider: (id) => `Provider ${id}`,
    ...overrides,
  }
}

describe("createRowDecorations", () => {
  describe("metadataFor", () => {
    it("resolves each field through the session → character → profile → built-in chain", () => {
      const { metadataFor } = createRowDecorations(sources({ defaultProvider: "profile-p" }))
      expect(metadataFor(session("s1", { characterId: "c1", projectId: "w1" }))).toEqual([
        { kind: "agent", value: "Alice" },
        { kind: "model", value: "Model claude-a" },
        { kind: "provider", value: "Provider anthropic" },
        { kind: "workspace", value: "Alpha" },
      ])
      // No character, no profile model: the built-in default fills in.
      expect(metadataFor(session("s2"))).toEqual([
        { kind: "model", value: "Model built-in-model" },
        { kind: "provider", value: "Provider profile-p" },
      ])
      // The row's own override wins.
      expect(
        metadataFor(session("s3", { characterId: "c1", model: "gpt", providerOverride: "openai" }))
      ).toEqual([
        { kind: "agent", value: "Alice" },
        { kind: "model", value: "Model gpt" },
        { kind: "provider", value: "Provider openai" },
      ])
    })

    it("follows the configured fields in their order", () => {
      const { metadataFor } = createRowDecorations(
        sources({ metadataFields: ["workspace", "agent"] })
      )
      expect(metadataFor(session("s", { characterId: "c1", projectId: "w1" }))).toEqual([
        { kind: "workspace", value: "Alpha" },
        { kind: "agent", value: "Alice" },
      ])
    })

    it("drops a team row's agent field in the merged rail, where its header names the squad", () => {
      const row = session("s", { kind: "team", teamId: "t1" })
      expect(createRowDecorations(sources()).metadataFor(row)[0]).toEqual({
        kind: "agent",
        value: "Squad",
      })
      expect(
        createRowDecorations(sources({ merged: true }))
          .metadataFor(row)
          .some((item) => item.kind === "agent")
      ).toBe(false)
    })

    it("returns the same array for the same session, and for another saying the same thing", () => {
      const { metadataFor } = createRowDecorations(sources())
      const row = session("s", { characterId: "c1" })
      const first = metadataFor(row)
      expect(metadataFor(row)).toBe(first)
      // The row changed for another reason (a new message): a new object, the
      // same metadata — the same array, so the memoized row sees no change.
      expect(metadataFor({ ...row, lastMessageAt: 99 })).toBe(first)
      expect(metadataFor(session("other", { characterId: "c1" }))).toBe(first)
    })

    it("returns one shared empty array when nothing is configured or resolvable", () => {
      const none = createRowDecorations(sources({ metadataFields: [] }))
      expect(none.metadataFor(session("a"))).toEqual([])
      expect(none.metadataFor(session("a"))).toBe(none.metadataFor(session("b")))
      const workspaceOnly = createRowDecorations(sources({ metadataFields: ["workspace"] }))
      expect(workspaceOnly.metadataFor(session("a"))).toBe(none.metadataFor(session("a")))
    })
  })

  describe("iconFor", () => {
    it("shares one subject per character and per team across every row", () => {
      const { iconFor } = createRowDecorations(sources())
      const first = iconFor(session("a", { characterId: "c2" }))
      expect(first).toEqual({
        name: "Bob",
        avatarColor: "#123456",
        avatarEmoji: "🐙",
        avatarImageUrl: undefined,
      })
      expect(iconFor(session("b", { characterId: "c2" }))).toBe(first)
      const team = iconFor(session("t", { kind: "team", teamId: "t1" }))
      expect(team).toMatchObject({ name: "Squad", avatarEmoji: "🧠" })
      expect(iconFor(session("t2", { kind: "team", teamId: "t1" }))).toBe(team)
    })

    it("carries a character's uploaded avatar image", () => {
      const withImage = {
        ...alice,
        avatarImage: { webDataUrl: "data:image/png;base64,AAA" },
      } as unknown as Character
      const { iconFor } = createRowDecorations(
        sources({ characterById: new Map([[withImage.id, withImage]]) })
      )
      expect(iconFor(session("a", { characterId: "c1" }))?.avatarImageUrl).toBe(
        "data:image/png;base64,AAA"
      )
    })

    it("is off when custom icons are, and undefined for an unknown entity", () => {
      expect(
        createRowDecorations(sources({ showCustomIcons: false })).iconFor(
          session("a", { characterId: "c1" })
        )
      ).toBeUndefined()
      const { iconFor } = createRowDecorations(sources())
      expect(iconFor(session("a", { characterId: "gone" }))).toBeUndefined()
      expect(iconFor(session("t", { kind: "team" }))).toBeUndefined()
    })
  })

  describe("accentFor", () => {
    it("is the team's colour for a team row and the character's for a direct one", () => {
      const { accentFor } = createRowDecorations(sources())
      expect(accentFor(session("t", { kind: "team", teamId: "t1" }))).toBe(avatarColor(squad))
      expect(accentFor(session("d", { characterId: "c2" }))).toBe("#123456")
      expect(accentFor(session("plain"))).toBeUndefined()
    })

    it("does not depend on the custom-icons switch", () => {
      expect(
        createRowDecorations(sources({ showCustomIcons: false })).accentFor(
          session("d", { characterId: "c2" })
        )
      ).toBe("#123456")
    })
  })
})
