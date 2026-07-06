// Fixture builders for assorted mobile-surface stories (chat composer pickers,
// message action sheet, remote-session approvals). Each builder returns a
// fully-valid object with realistic defaults; spread `over` to vary a field.
import type { UIMessage } from "ai"

import type { Character, PendingApproval, Skill } from "@/lib/claude/types"

let characterSeq = 0
let messageSeq = 0

const AVATAR_PALETTE = [
  "oklch(0.62 0.19 256)",
  "oklch(0.66 0.17 150)",
  "oklch(0.70 0.18 40)",
  "oklch(0.64 0.20 320)",
]

/** Build a minimal-but-valid `Character` persona. */
export function makeCharacter(over: Partial<Character> = {}): Character {
  characterSeq += 1
  return {
    id: `character-${characterSeq}`,
    name: `Persona ${characterSeq}`,
    description: "A reusable assistant persona.",
    avatarColor: AVATAR_PALETTE[characterSeq % AVATAR_PALETTE.length],
    avatarEmoji: "🤖",
    systemPrompt: "You are a helpful assistant.",
    createdAt: 0,
    updatedAt: new Date("2026-06-01T09:00:00.000Z").getTime(),
    ...over,
  }
}

/** A small ready-made roster for @-mention pickers. */
export function makeCharacterRoster(): Character[] {
  return [
    makeCharacter({ name: "Researcher", avatarEmoji: "🔬" }),
    makeCharacter({ name: "Reviewer", avatarEmoji: "🔍" }),
    makeCharacter({ name: "Planner", avatarEmoji: "🗺️" }),
    makeCharacter({ name: "Builder", avatarEmoji: "🛠️" }),
  ]
}

/** Build a text-only `UIMessage` (AI SDK transport shape). */
export function makeUIMessage(over: Partial<UIMessage> = {}): UIMessage {
  messageSeq += 1
  return {
    id: `message-${messageSeq}`,
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Here is the summary you asked for, with three key takeaways.",
      },
    ],
    ...over,
  } as UIMessage
}

/** Build a pending tool-use approval routed to a mobile device. */
export function makePendingApproval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    sessionId: "session-1",
    requestId: "req-1",
    toolUseID: "toolu-1",
    toolName: "Bash",
    displayName: "Run shell command",
    description: "The host agent wants to run a shell command on your desktop.",
    input: { command: "ls -la ~/projects", description: "List the projects directory" },
    ...over,
  }
}

/** Build a minimal-but-valid `Skill` row. */
export function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    name: "Release notes writer",
    description: "Turns a changelog into polished release notes.",
    content: "## Release notes writer\n\nSummarize the changelog into user-facing notes.",
    category: "productivity",
    source: "custom",
    status: "enabled",
    usageCount: 12,
    createdAt: 0,
    updatedAt: new Date("2026-06-01T09:00:00.000Z").getTime(),
    ...over,
  }
}
