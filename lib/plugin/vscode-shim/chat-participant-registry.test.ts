/**
 * Tests for `chat-participant-registry`.
 *
 * Each VS Code chat participant becomes a virtual `Character` in cognia's
 * Dexie `characters` table. We inject a memory store via
 * `configureChatRegistry` so the suite stays Dexie-free.
 */

import {
  __listParticipantsForTesting,
  __resetChatRegistryForTesting,
  configureChatRegistry,
  disposeAllParticipantsFor,
  handleChatParticipantRespond,
  handleCreateChatParticipant,
  handleDisposeChatParticipant,
  handleRegisterChatVariableResolver,
} from "./chat-participant-registry"
import type { Character } from "@/lib/claude/types"

function makeMemoryStore() {
  const characters = new Map<string, Character>()
  configureChatRegistry({
    upsertCharacter: async (character) => {
      characters.set(character.id, character)
    },
    deleteCharacter: async (id) => {
      characters.delete(id)
    },
  })
  return characters
}

describe("chat-participant-registry", () => {
  beforeEach(() => {
    __resetChatRegistryForTesting()
  })

  describe("handleCreateChatParticipant", () => {
    it("upserts a virtual Character and tracks the handle", async () => {
      const characters = makeMemoryStore()
      const { characterId } = await handleCreateChatParticipant({
        extensionId: "ext.cline",
        id: "cline",
        name: "Cline",
        description: "AI coding assistant",
        iconEmoji: "🤖",
        respondToken: "respond-1",
      })
      expect(characterId).toBe("vscode-chat:ext.cline:cline")
      expect(characters.get(characterId)).toEqual(
        expect.objectContaining({
          id: characterId,
          name: "Cline",
          description: "AI coding assistant",
          avatarEmoji: "🤖",
          systemPrompt: "",
        })
      )
      expect(__listParticipantsForTesting()).toEqual([
        expect.objectContaining({
          pluginId: "ext.cline",
          participantId: "cline",
          characterId,
          respondToken: "respond-1",
        }),
      ])
    })

    it("treats a second registration as an update, not a duplicate", async () => {
      const characters = makeMemoryStore()
      const first = await handleCreateChatParticipant({
        extensionId: "ext",
        id: "p",
        respondToken: "t1",
      })
      const second = await handleCreateChatParticipant({
        extensionId: "ext",
        id: "p",
        respondToken: "t2",
      })
      expect(second.characterId).toBe(first.characterId)
      expect(__listParticipantsForTesting()).toHaveLength(1)
      expect(__listParticipantsForTesting()[0]!.respondToken).toBe("t2")
      // Only one upsert + the same character body remains.
      expect(characters.size).toBe(1)
    })

    it("survives an upsertCharacter failure (warn + continue)", async () => {
      configureChatRegistry({
        upsertCharacter: async () => {
          throw new Error("dexie unavailable")
        },
        deleteCharacter: async () => {},
      })
      const { characterId } = await handleCreateChatParticipant({
        extensionId: "ext.x",
        id: "p",
      })
      expect(characterId).toBe("vscode-chat:ext.x:p")
      // Handle is still recorded so dispose can clean up.
      expect(__listParticipantsForTesting()).toHaveLength(1)
    })
  })

  describe("handleDisposeChatParticipant", () => {
    it("removes the handle and deletes the character", async () => {
      const characters = makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext", id: "p" })
      expect(characters.size).toBe(1)
      await handleDisposeChatParticipant({ extensionId: "ext", id: "p" })
      expect(characters.size).toBe(0)
      expect(__listParticipantsForTesting()).toHaveLength(0)
    })

    it("is a no-op when the participant is unknown", async () => {
      makeMemoryStore()
      await expect(
        handleDisposeChatParticipant({ extensionId: "ext", id: "missing" })
      ).resolves.toBeUndefined()
    })
  })

  describe("handleRegisterChatVariableResolver", () => {
    it("attaches the resolver token to the participant handle", async () => {
      makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext", id: "p" })
      const result = handleRegisterChatVariableResolver({
        extensionId: "ext",
        participantId: "p",
        name: "selection",
        token: "var-1",
      })
      expect(result).toEqual({ registered: true })
      expect(__listParticipantsForTesting()[0]!.variableResolverToken).toBe("var-1")
    })

    it("throws when the participant doesn't exist", () => {
      makeMemoryStore()
      expect(() =>
        handleRegisterChatVariableResolver({
          extensionId: "ext",
          participantId: "missing",
          name: "x",
          token: "t",
        })
      ).toThrow(/missing.*is not registered/)
    })
  })

  describe("handleChatParticipantRespond", () => {
    it("accepts a payload without throwing", () => {
      expect(() =>
        handleChatParticipantRespond({
          extensionId: "ext",
          id: "p",
          payload: { prompt: "Hello" },
        })
      ).not.toThrow()
    })

    it("handles a missing prompt gracefully", () => {
      expect(() =>
        handleChatParticipantRespond({
          extensionId: "ext",
          id: "p",
          payload: { prompt: "" },
        })
      ).not.toThrow()
    })
  })

  describe("disposeAllParticipantsFor", () => {
    it("drops every handle and character for the given extension only", async () => {
      const characters = makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext.a", id: "p1" })
      await handleCreateChatParticipant({ extensionId: "ext.a", id: "p2" })
      await handleCreateChatParticipant({ extensionId: "ext.b", id: "p3" })
      expect(characters.size).toBe(3)
      await disposeAllParticipantsFor("ext.a")
      expect(characters.size).toBe(1)
      const remaining = __listParticipantsForTesting()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.pluginId).toBe("ext.b")
    })

    it("swallows delete failures so cleanup never aborts mid-loop", async () => {
      configureChatRegistry({
        upsertCharacter: async () => {},
        deleteCharacter: async () => {
          throw new Error("dexie boom")
        },
      })
      await handleCreateChatParticipant({ extensionId: "ext", id: "p1" })
      await handleCreateChatParticipant({ extensionId: "ext", id: "p2" })
      await disposeAllParticipantsFor("ext")
      // Local handles cleared even though storage failed.
      expect(__listParticipantsForTesting()).toHaveLength(0)
    })
  })
})
