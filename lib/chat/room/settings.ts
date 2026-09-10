/**
 * Room settings: defaults per kind, and the one patch that keeps
 * `roomSettings.memory` and the session's memory switches in step.
 *
 * Why the memory switch is duplicated on purpose: `resolveAgentMemoryPolicy`
 * reads `session.memoryUse` / `session.memoryLearn`, and every recall and
 * distillation site already honours those. Writing them from here means a
 * room's memory choice takes effect with no change to the memory plane, and a
 * legacy row that only has the two booleans still reads back as a setting.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { roomKindOf, isMultiHumanRoom, type RoomKindSource } from "./kind"
import type { ResolvedRoomSettings, RoomReplyMode, RoomSettings } from "./types"

export const DEFAULT_ROOM_REPLY_MODE: RoomReplyMode = "auto"
export const ROOM_REPLY_MODES: readonly RoomReplyMode[] = ["auto", "mention_only", "asleep"]

/** Longest instructions block injected into a prompt. */
export const MAX_ROOM_INSTRUCTIONS_CHARS = 4_000

export type RoomSettingsSource = RoomKindSource &
  Pick<ChatSession, "roomSettings" | "memoryUse" | "memoryLearn">

/** The memory default for a room of this kind. */
export function defaultRoomMemory(kind: ReturnType<typeof roomKindOf>): boolean {
  return !isMultiHumanRoom(kind)
}

export function resolveRoomSettings(
  session: RoomSettingsSource | null | undefined
): ResolvedRoomSettings {
  const kind = roomKindOf(session)
  const stored = session?.roomSettings
  const replyMode =
    stored?.replyMode && ROOM_REPLY_MODES.includes(stored.replyMode)
      ? stored.replyMode
      : DEFAULT_ROOM_REPLY_MODE
  const instructions = clampInstructions(stored?.instructions)
  let memory: boolean
  let memoryDefaulted = false
  if (typeof stored?.memory === "boolean") {
    memory = stored.memory
  } else if (typeof session?.memoryUse === "boolean") {
    memory = session.memoryUse
  } else {
    memory = defaultRoomMemory(kind)
    memoryDefaulted = true
  }
  const mutedMemberIds = Array.isArray(stored?.mutedMemberIds)
    ? Array.from(new Set(stored.mutedMemberIds.filter((id) => typeof id === "string" && id)))
    : []
  return { kind, replyMode, instructions, memory, mutedMemberIds, memoryDefaulted }
}

export function clampInstructions(text: string | undefined): string {
  const trimmed = (text ?? "").trim()
  if (trimmed.length <= MAX_ROOM_INSTRUCTIONS_CHARS) return trimmed
  return trimmed.slice(0, MAX_ROOM_INSTRUCTIONS_CHARS)
}

/**
 * The session patch for one settings change. Always writes the whole
 * `roomSettings` object (Dexie replaces the field), and mirrors `memory` onto
 * the two switches the memory plane reads.
 */
export function roomSettingsPatch(
  current: RoomSettings | undefined,
  change: Partial<RoomSettings>
): Pick<ChatSession, "roomSettings" | "memoryUse" | "memoryLearn"> {
  const next: RoomSettings = { ...(current ?? {}), ...change }
  if ("instructions" in change) next.instructions = clampInstructions(change.instructions)
  if ("mutedMemberIds" in change) {
    next.mutedMemberIds = Array.from(new Set((change.mutedMemberIds ?? []).filter(Boolean)))
  }
  const patch: Pick<ChatSession, "roomSettings" | "memoryUse" | "memoryLearn"> = {
    roomSettings: next,
  }
  if (typeof change.memory === "boolean") {
    patch.memoryUse = change.memory
    patch.memoryLearn = change.memory
  }
  return patch
}

/**
 * The prompt section for room instructions, or `""` when there are none.
 * Sits beside the roster and scratchpad sections in `team-transcript.ts`.
 */
export function buildRoomInstructionsSection(instructions: string | undefined): string {
  const text = clampInstructions(instructions)
  if (!text) return ""
  return ["## Room instructions", "", text].join("\n")
}

/**
 * The fields the memory plane needs when a room is minted (an IM group
 * session, a shared import). Callers spread this into the new row so a
 * multi-human room starts with memory off without a settings sheet visit.
 */
export function initialRoomMemoryFields(
  kind: ReturnType<typeof roomKindOf>
): Pick<ChatSession, "memoryUse" | "memoryLearn"> {
  const memory = defaultRoomMemory(kind)
  return memory ? {} : { memoryUse: false, memoryLearn: false }
}
