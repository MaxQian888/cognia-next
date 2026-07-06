// Fixture builders for the mobile Discover stories (character / skill / team
// cards, twin drafts, and the `DiscoverItem` envelope the share/action sheets
// consume). Spread `over` to vary a single field; every required column gets a
// realistic default so the object is valid to render or to `bulkPut` into
// Dexie. See `lib/claude/types.ts` (Character / Skill / Team) and
// `types/twin/index.ts` (TwinDraft) for the canonical shapes.
import type { Character, Skill, Team } from "@/lib/claude/types"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import type { TwinDraft } from "@/types/twin"

let charSeq = 0
let skillSeq = 0
let teamSeq = 0
let draftSeq = 0

const BASE_TS = 1_700_000_000_000

/** A minimal-but-valid `Character`. */
export function makeCharacter(over: Partial<Character> = {}): Character {
  charSeq += 1
  return {
    id: `char-${charSeq}`,
    name: `Persona ${charSeq}`,
    description: "A focused assistant tuned for one recurring kind of task.",
    avatarColor: "#6366f1",
    avatarEmoji: "🤖",
    systemPrompt: "You are a concise, helpful assistant.",
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    ...over,
  }
}

/** A minimal-but-valid `Skill`. */
export function makeSkill(over: Partial<Skill> = {}): Skill {
  skillSeq += 1
  return {
    id: `skill-${skillSeq}`,
    name: `Skill ${skillSeq}`,
    description: "Appends a focused capability to the system prompt at send time.",
    content: "## Skill\nDo the thing well.",
    status: "enabled",
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    ...over,
  }
}

/** A minimal-but-valid `Team`. */
export function makeTeam(over: Partial<Team> = {}): Team {
  teamSeq += 1
  return {
    id: `team-${teamSeq}`,
    name: `Team ${teamSeq}`,
    description: "A round-robin crew that splits a task across personas.",
    avatarColor: "#0ea5e9",
    members: [
      { characterId: "char-1", role: "Researcher" },
      { characterId: "char-2", role: "Critic" },
    ],
    orchestration: "round_robin",
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    ...over,
  }
}

/** A `TwinDraft` (defaults to a pending character draft). */
export function makeTwinDraft(over: Partial<TwinDraft> = {}): TwinDraft {
  draftSeq += 1
  return {
    id: `draft-${draftSeq}`,
    twinId: "default",
    jobId: `job-${draftSeq}`,
    kind: "character",
    payload: {
      kind: "character",
      data: {
        name: `Distilled persona ${draftSeq}`,
        description: "Synthesized from your recent writing samples.",
        systemPrompt: "Mirror the user's tone: warm, direct, lightly technical.",
      },
    },
    provenance: {
      chunkIds: ["chunk-1", "chunk-2"],
      rationale: "Recurring tone across 12 samples.",
    },
    evaluation: { qualityScore: 0.82, concerns: [], suggestions: [] },
    status: "pending",
    createdAt: BASE_TS,
    ...over,
  }
}

/** Wrap a `Character` in the `DiscoverItem` envelope the share/action sheets take. */
export function makeCharacterDiscoverItem(over: Partial<Character> = {}): DiscoverItem {
  const data = makeCharacter(over)
  return { kind: "character", id: data.id, data }
}
