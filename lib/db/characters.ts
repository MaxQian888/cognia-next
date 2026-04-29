import type { Character } from "@/lib/claude/types"
import { getDb } from "./schema"

function newId() {
  return "char_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listCharacters(): Promise<Character[]> {
  return getDb().characters.orderBy("name").toArray()
}

export async function getCharacter(id: string): Promise<Character | undefined> {
  return getDb().characters.get(id)
}

export async function listCharactersByIds(ids: string[]): Promise<Character[]> {
  if (ids.length === 0) return []
  const rows = await getDb().characters.bulkGet(ids)
  // Preserve incoming order; drop missing ids.
  return rows.filter((r): r is Character => r !== undefined)
}

export type CharacterDraft = Pick<Character, "name" | "systemPrompt"> &
  Partial<
    Pick<
      Character,
      | "description"
      | "avatarColor"
      | "avatarEmoji"
      | "model"
      | "permissionMode"
      | "allowedTools"
      | "disallowedTools"
      | "mcpServerIds"
      | "skillIds"
      | "workingDir"
    >
  >

export async function createCharacter(draft: CharacterDraft): Promise<Character> {
  const now = Date.now()
  const character: Character = {
    id: newId(),
    name: draft.name.trim() || "Untitled character",
    description: draft.description,
    avatarColor: draft.avatarColor ?? "oklch(0.7 0.15 250)",
    avatarEmoji: draft.avatarEmoji,
    systemPrompt: draft.systemPrompt,
    model: draft.model,
    permissionMode: draft.permissionMode,
    allowedTools: draft.allowedTools,
    disallowedTools: draft.disallowedTools,
    mcpServerIds: draft.mcpServerIds,
    skillIds: draft.skillIds,
    workingDir: draft.workingDir,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().characters.put(character)
  return character
}

export async function updateCharacter(
  id: string,
  patch: Partial<Omit<Character, "id" | "createdAt" | "isBuiltIn">>
): Promise<void> {
  await getDb().characters.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteCharacter(id: string): Promise<void> {
  const existing = await getDb().characters.get(id)
  if (existing?.isBuiltIn) {
    throw new Error("Built-in characters cannot be deleted. Duplicate first.")
  }
  await getDb().characters.delete(id)
}

/**
 * Clone a character (built-in or otherwise) into a new editable copy. The copy
 * is never marked as built-in regardless of the source.
 */
export async function duplicateCharacter(id: string): Promise<Character> {
  const source = await getDb().characters.get(id)
  if (!source) throw new Error(`Character ${id} not found`)
  const now = Date.now()
  const copy: Character = {
    ...source,
    id: newId(),
    name: `${source.name} (copy)`,
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().characters.put(copy)
  return copy
}

/**
 * Idempotently insert built-in characters. Identified by stable ids so repeat
 * calls never duplicate or overwrite user edits to anything that doesn't match
 * a built-in id.
 */
export async function seedBuiltInCharacters(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const builtIns: Character[] = [
    {
      id: "char_builtin_coding",
      name: "Coding Assistant",
      description: "Pragmatic engineer. Ships small, tested changes; explains tradeoffs.",
      avatarColor: "oklch(0.65 0.18 245)",
      avatarEmoji: "💻",
      systemPrompt:
        "You are a senior software engineer pairing with the user. Prefer minimal, tested changes over sweeping rewrites. When you're uncertain, say so. Always show the file path and a short rationale alongside any code you produce.",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "char_builtin_writer",
      name: "Writing Editor",
      description: "Tightens prose without changing voice. Flags vague claims.",
      avatarColor: "oklch(0.7 0.15 30)",
      avatarEmoji: "✍️",
      systemPrompt:
        "You are a precise editor. Tighten the user's writing without changing its voice. Flag vague claims, hedging, and unsupported assertions. Offer two alternatives for any line you rewrite, and explain the difference.",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "char_builtin_research",
      name: "Research Analyst",
      description: "Structures questions, weighs evidence, surfaces unknowns.",
      avatarColor: "oklch(0.7 0.13 150)",
      avatarEmoji: "🔎",
      systemPrompt:
        "You are a research analyst. For every question, restate the underlying claim, list the evidence you'd want to see, and identify the strongest counter-argument. Distinguish what you know from what you're inferring.",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "char_builtin_brainstorm",
      name: "Brainstorm Buddy",
      description: "Generates wide-ranging options, then narrows.",
      avatarColor: "oklch(0.78 0.16 90)",
      avatarEmoji: "💡",
      systemPrompt:
        "You are a generative brainstorming partner. First produce a wide list of options without filtering. Then group them and identify the two or three most promising directions, with the tradeoff for each.",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "char_builtin_translator",
      name: "Translator",
      description: "Translates between languages while preserving register and intent.",
      avatarColor: "oklch(0.7 0.14 320)",
      avatarEmoji: "🌐",
      systemPrompt:
        "You are a careful translator. Preserve the source's register, idiom, and intent rather than rendering word-for-word. When a phrase has multiple plausible translations, list the alternatives and explain when each fits.",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
  await db.characters.bulkPut(builtIns)
}
