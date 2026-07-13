// Orchestrates one turn of the pet CHAT panel (the multi-turn counterpart of
// the `usePetSpeak` bubble side channel). Same guarantees — a hard PII gate
// before anything reaches the embedder/model, a rate limiter, and the utility
// client — but it returns a DISCRIMINATED RESULT so the panel can tell the user
// WHY a turn degraded (the bubble path fails silently). Completed turns are
// recorded to `petConversation`, so they flow straight into the transcript's
// live query.
//
// Every collaborator is injectable (`deps`) so this is unit-tested without a
// model, IndexedDB, or the twin/vector stack; production uses the defaults.

import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import type { PetOneShot, PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

import { hasNoLeakingPii } from "@cognia/redact"
import { getSpeakLimiter } from "@/lib/pet/bubbles/speak-limiter"
import {
  buildUtilityLlmClient,
  type BuildUtilityClientArgs,
} from "@/lib/ai/generation/utility-client"
import { chatAsPet } from "@/lib/pet/bubbles/speak"
import {
  formatHistoryLines,
  loadHistoryForPrompt,
  recordTurn,
  type PetHistoryDeps,
} from "@/lib/pet/llm/history"
import { appendPetTurn, listRecentPetTurns } from "@/lib/db/pet-conversation"
import { recallAboutUser } from "@/lib/pet/llm/recall"
import { EMOTION_TO_ONESHOT, parseEmotion } from "@/lib/pet/llm/emotion-tags"
import { resolveMemoryConfig } from "@/types/memory/memory"

/** Why a chat turn did not produce a real reply (surfaced in the panel). */
export type PetChatDegradeReason =
  "disabled" | "pii" | "rateLimited" | "noClient" | "empty" | "error"

export type PetChatResult =
  | { status: "ok"; reply: string; emotion?: PetOneShot }
  | { status: "degraded"; reason: PetChatDegradeReason }

export interface RespondAsPetInput {
  userText: string
  view: PetView | undefined
  profile: PetProfile | undefined
  appSettings: AppSettings | null | undefined
  locale: string
  activeCharacterId?: string | null
  /** Epoch ms for the turn (injected — never read the clock in here). */
  at: number
}

export interface PetChatDeps {
  hasNoLeakingPii: (text: string) => boolean
  tryAcquire: (now: number) => boolean
  buildClient: (args: BuildUtilityClientArgs) => LlmClient | null
  chat: (client: LlmClient | null, args: Parameters<typeof chatAsPet>[1]) => Promise<string | null>
  history: PetHistoryDeps
  loadMemoryDeps: (
    appSettings: AppSettings | null | undefined
  ) => Promise<MemoryRetrieverDeps | null>
  recall: typeof recallAboutUser
  resolveCharacterPersona: (id: string) => Promise<string | null>
  parseEmotion: typeof parseEmotion
}

const HISTORY_DEPS: PetHistoryDeps = { append: appendPetTurn, listRecent: listRecentPetTurns }

async function defaultLoadMemoryDeps(
  appSettings: AppSettings | null | undefined
): Promise<MemoryRetrieverDeps | null> {
  return (
    (await import("@/lib/memory/runtime/build-deps")
      .then((m) => m.tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory)))
      .catch(() => null)) ?? null
  )
}

async function defaultResolveCharacterPersona(id: string): Promise<string | null> {
  return (
    (await import("@/lib/pet/llm/character-persona")
      .then((m) => m.resolveCharacterPersona(id))
      .catch(() => null)) ?? null
  )
}

const DEFAULT_DEPS: PetChatDeps = {
  hasNoLeakingPii,
  tryAcquire: (now) => getSpeakLimiter().tryAcquire(now),
  buildClient: buildUtilityLlmClient,
  chat: chatAsPet,
  history: HISTORY_DEPS,
  loadMemoryDeps: defaultLoadMemoryDeps,
  recall: recallAboutUser,
  resolveCharacterPersona: defaultResolveCharacterPersona,
  parseEmotion,
}

/**
 * Produce one pet chat reply. Never throws — every failure is a `degraded`
 * result with a reason. On success the turn is recorded to history (when pet
 * memory is on) so the transcript's live query picks it up.
 */
export async function respondAsPet(
  input: RespondAsPetInput,
  overrides: Partial<PetChatDeps> = {}
): Promise<PetChatResult> {
  const d = { ...DEFAULT_DEPS, ...overrides }
  const userText = (input.userText ?? "").trim()
  const llmSpeak = input.appSettings?.petSettings?.llmSpeak
  const soul = input.profile?.soul

  // Degradations that never reach the model.
  if (!userText || !llmSpeak?.enabled || !soul || !input.view) {
    return { status: "degraded", reason: "disabled" }
  }
  if (!d.tryAcquire(input.at)) return { status: "degraded", reason: "rateLimited" }
  // Privacy gate: the text feeds BOTH the recall embedding (possibly cloud) and
  // the model prompt, so gate here BEFORE recall — mirrors `usePetSpeak`.
  if (!d.hasNoLeakingPii(userText)) return { status: "degraded", reason: "pii" }

  const client = d.buildClient({
    session: null,
    appSettings: input.appSettings,
    override: llmSpeak,
    featureId: "pet-chat",
  })
  if (!client) return { status: "degraded", reason: "noClient" }

  const memoryOn = input.appSettings?.petSettings?.petMemory?.enabled !== false
  const view = input.view

  // Prompt layers, each degrading independently.
  const historyText = memoryOn ? formatHistoryLines(await loadHistoryForPrompt(d.history)) : ""
  const memDeps = await d.loadMemoryDeps(input.appSettings)
  const recallText = await d.recall(memDeps ?? undefined, { queryText: userText })

  let persona: string | undefined
  const charId = input.activeCharacterId ?? null
  if (charId) {
    const resolved = await d.resolveCharacterPersona(charId)
    if (resolved && d.hasNoLeakingPii(resolved)) persona = resolved
  }

  let raw: string | null
  try {
    raw = await d.chat(client, {
      soul,
      bones: view.effectiveBones,
      userText,
      persona,
      state: {
        mood: view.mood,
        energy: Math.round(view.needs.energy),
        bond: Math.round(view.needs.bond),
        level: input.profile?.level ?? 1,
      },
      historyText: historyText || undefined,
      recallText: recallText || undefined,
      emotionInstruction: true,
      locale: input.locale,
    })
  } catch {
    return { status: "degraded", reason: "error" }
  }

  const parsed = raw ? d.parseEmotion(raw) : null
  if (!parsed || !parsed.cleanText) return { status: "degraded", reason: "empty" }

  if (memoryOn) {
    await recordTurn(d.history, { userText, reply: parsed.cleanText, at: input.at })
  }
  return {
    status: "ok",
    reply: parsed.cleanText,
    emotion: parsed.emotion ? EMOTION_TO_ONESHOT[parsed.emotion] : undefined,
  }
}
