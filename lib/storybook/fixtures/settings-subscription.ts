// Storybook fixture builders for the Settings → Subscription stories.
//
// Most subscription components read from the keyring transport / balance /
// limits hooks, which in the Storybook (non-Tauri) browser resolve to their
// empty / unavailable branches — those stories render the default branch with
// no seeding. The one place seeding genuinely changes the render is
// `AccountUsageChips`, which reads `listCharacters()` / `listSessions()` from
// Dexie; the builders below produce type-safe rows for that story.

import type { Character, ChatSession } from "@cognia/agent-config-types"

let charSeq = 0
let sessionSeq = 0

/**
 * A persisted `Character` row. Pass `accountIdOverride` to pin the character to
 * a subscription account so `AccountUsageChips` surfaces an "in use" chip.
 */
export function makeCharacter(overrides: Partial<Character> = {}): Character {
  charSeq += 1
  const now = Date.UTC(2026, 5, 1) + charSeq * 1000
  return {
    id: `char_story_${charSeq}`,
    name: `Story Persona ${charSeq}`,
    avatarColor: "oklch(0.7 0.15 250)",
    avatarEmoji: "🤖",
    systemPrompt: "You are a helpful assistant.",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/**
 * A persisted `ChatSession` row. Pass `accountId` to pin the session to a
 * subscription account so `AccountUsageChips` surfaces an "in use" chip.
 */
export function makeChatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  sessionSeq += 1
  const now = Date.UTC(2026, 5, 1) + sessionSeq * 1000
  return {
    id: `session_story_${sessionSeq}`,
    title: `Story Session ${sessionSeq}`,
    kind: "direct",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}
