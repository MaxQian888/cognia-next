/**
 * `vscode.chat` participant registry — maps VS Code chat participants into
 * cognia's Character system.
 *
 * Each extension that calls `chat.createChatParticipant(id, handler)` lands
 * here through the renderer-side RPC dispatcher. We upsert a virtual
 * `Character` (id pattern `vscode-chat:${pluginId}:${id}`) into the Dexie
 * `characters` table so cognia's existing character chooser, inbox, and
 * chat composer treat it like any first-party character.
 *
 * Participant invocation (the actual `chatParticipant.respond(...)` call)
 * isn't wired here — that piece is the next iteration of this plan. For
 * now we cover the registration / disposal lifecycle so extensions don't
 * see "method not found" and so the character appears in cognia's UI as a
 * stable, dismissable entry.
 */

import type { Character } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"
import { loggers } from "@/lib/logging"

const chatLogger = loggers.plugin.child("vscode-chat")

interface ParticipantHandle {
  pluginId: string
  participantId: string
  characterId: string
  /** Token the sidecar gave us for `respond` callbacks. */
  respondToken?: string
  /** Token for `chatVariableResolver`. */
  variableResolverToken?: string
}

const participants = new Map<string, ParticipantHandle>()

function buildCharacterId(pluginId: string, participantId: string): string {
  return `vscode-chat:${pluginId}:${participantId}`
}

interface CreateParticipantPayload {
  extensionId: string
  /** Participant id as declared by `chat.createChatParticipant(id, …)`. */
  id: string
  /** Display name (defaults to `id` when omitted). */
  name?: string
  /** Optional one-line description shown in cognia's chooser. */
  description?: string
  /** Optional emoji used for the avatar. */
  iconEmoji?: string
  /** Token the sidecar gave us so we can call the participant later. */
  respondToken?: string
}

interface DisposeParticipantPayload {
  extensionId: string
  id: string
}

interface RegisterVariableResolverPayload {
  extensionId: string
  /** Participant the resolver belongs to. */
  participantId: string
  /** Variable name (e.g. `selection`). */
  name: string
  token: string
}

interface ParticipantRespondPayload {
  /** Plugin/extension that owns the participant. */
  extensionId: string
  /** Participant id. */
  id: string
  /** Free-form payload — at minimum a `prompt` string. */
  payload: {
    prompt: string
    [key: string]: unknown
  }
}

/**
 * Test-only override hooks for the storage layer. Production code uses
 * the real `getDb()` Dexie store; tests inject an in-memory stand-in to
 * keep the suite Dexie-free.
 */
interface ChatRegistryDeps {
  upsertCharacter: (character: Character) => Promise<void>
  deleteCharacter: (id: string) => Promise<void>
}

let deps: ChatRegistryDeps = {
  upsertCharacter: async (character) => {
    await getDb().characters.put(character)
  },
  deleteCharacter: async (id) => {
    await getDb().characters.delete(id)
  },
}

export function configureChatRegistry(overrides: Partial<ChatRegistryDeps>): void {
  deps = { ...deps, ...overrides }
}

export function __resetChatRegistryForTesting(): void {
  participants.clear()
  deps = {
    upsertCharacter: async (character) => {
      await getDb().characters.put(character)
    },
    deleteCharacter: async (id) => {
      await getDb().characters.delete(id)
    },
  }
}

export async function handleCreateChatParticipant(
  payload: CreateParticipantPayload
): Promise<{ characterId: string }> {
  const key = `${payload.extensionId}::${payload.id}`
  const existing = participants.get(key)
  if (existing) {
    chatLogger.debug("chat participant already registered; updating handle", {
      pluginId: payload.extensionId,
      participantId: payload.id,
    })
    existing.respondToken = payload.respondToken ?? existing.respondToken
    return { characterId: existing.characterId }
  }
  const characterId = buildCharacterId(payload.extensionId, payload.id)
  const now = Date.now()
  const character: Character = {
    id: characterId,
    name: payload.name ?? payload.id,
    description: payload.description,
    avatarColor: "oklch(0.72 0.14 285)",
    avatarEmoji: payload.iconEmoji,
    systemPrompt: "",
    createdAt: now,
    updatedAt: now,
  }
  try {
    await deps.upsertCharacter(character)
  } catch (err) {
    chatLogger.warn("upsertCharacter failed; participant will not appear in chooser", {
      pluginId: payload.extensionId,
      participantId: payload.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  participants.set(key, {
    pluginId: payload.extensionId,
    participantId: payload.id,
    characterId,
    respondToken: payload.respondToken,
  })
  return { characterId }
}

export async function handleDisposeChatParticipant(
  payload: DisposeParticipantPayload
): Promise<void> {
  const key = `${payload.extensionId}::${payload.id}`
  const handle = participants.get(key)
  if (!handle) return
  participants.delete(key)
  try {
    await deps.deleteCharacter(handle.characterId)
  } catch (err) {
    chatLogger.warn("deleteCharacter failed during participant disposal", {
      pluginId: payload.extensionId,
      participantId: payload.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function handleRegisterChatVariableResolver(payload: RegisterVariableResolverPayload): {
  registered: true
} {
  const key = `${payload.extensionId}::${payload.participantId}`
  const handle = participants.get(key)
  if (!handle) {
    throw new Error(
      `chat.registerChatVariableResolver: participant ${payload.participantId} from ${payload.extensionId} is not registered`
    )
  }
  handle.variableResolverToken = payload.token
  return { registered: true }
}

/**
 * Notification handler the sidecar can fire to surface a streaming chunk
 * back from a participant. The renderer side currently just logs; the
 * chat UI binding lands in the next iteration. We keep the handler in
 * place so the sidecar's `respond()` callback gets a valid pipe.
 */
export function handleChatParticipantRespond(payload: ParticipantRespondPayload): void {
  chatLogger.debug("chat participant respond received", {
    pluginId: payload.extensionId,
    participantId: payload.id,
    promptLength: payload.payload?.prompt?.length ?? 0,
  })
}

/**
 * Drop every participant owned by `extensionId` and delete the matching
 * virtual characters. Called by the plugin manager during extension
 * deactivate.
 */
export async function disposeAllParticipantsFor(extensionId: string): Promise<void> {
  const keys: string[] = []
  for (const [key, handle] of participants) {
    if (handle.pluginId === extensionId) keys.push(key)
  }
  for (const key of keys) {
    const handle = participants.get(key)
    if (!handle) continue
    participants.delete(key)
    try {
      await deps.deleteCharacter(handle.characterId)
    } catch (err) {
      chatLogger.warn("deleteCharacter failed during bulk disposal", {
        pluginId: extensionId,
        participantId: handle.participantId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export function __listParticipantsForTesting(): ParticipantHandle[] {
  return [...participants.values()]
}
