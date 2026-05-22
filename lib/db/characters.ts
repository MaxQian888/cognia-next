import type { Character } from "@/lib/claude/types"
import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"
import {
  buildOverlayCharacterId,
  getPackCharacterByRuntimeId,
  isOverlayCharacterId,
  listAllPackCharacters,
} from "@/lib/plugin/registries/character-pack-registry"
import { getDb } from "./schema"

function newId() {
  return "char_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * Project a plugin-contributed `PluginCharacterDef` into a transient
 * `Character` row (ADR-0030). The returned row is NOT persisted to Dexie —
 * it lives in memory for the duration of the overlay registration. The
 * synthetic `id` uses the `cognia-pack:` namespace
 * (`cognia-pack:<pluginId>:<packId>:<localId>`) so it never collides with
 * the Dexie-resident `char_*` namespace.
 *
 * `createdAt` / `updatedAt` are pinned to 0 as deterministic sentinels so
 * UI sort-by-recency surfaces never mistake an overlay row for a fresh
 * user creation. The `sourcePluginId` / `sourcePackId` fields piggyback on
 * the Character schema (added by ADR-0030) so the row's plugin origin
 * survives projection without a separate side-channel.
 */
export function projectOverlayCharacter(
  pack: PluginCharacterPackDef,
  ch: PluginCharacterDef,
  pluginId?: string
): Character {
  return {
    id: buildOverlayCharacterId(pluginId, pack.id, ch.localId),
    name: ch.name,
    description: ch.description,
    avatarColor: ch.avatarColor,
    avatarEmoji: ch.avatarEmoji,
    systemPrompt: ch.systemPrompt,
    model: ch.model,
    providerId: ch.providerId,
    permissionMode: ch.permissionMode,
    allowedTools: ch.allowedTools,
    disallowedTools: ch.disallowedTools,
    mcpServerIds: ch.mcpServerIds,
    skillIds: ch.skillIds,
    pluginSkillIds: ch.pluginSkillIds,
    workingDir: ch.workingDir,
    bareMode: ch.bareMode,
    debugMode: ch.debugMode,
    briefMode: ch.briefMode,
    enableComputerUse: ch.enableComputerUse,
    computerUseSettings: ch.computerUseSettings,
    sandboxEnabled: ch.sandboxEnabled,
    sandboxTier: ch.sandboxTier,
    platformDefaults: ch.platformDefaults,
    a2uiEnabled: ch.a2uiEnabled,
    a2uiCatalogId: ch.a2uiCatalogId,
    isBuiltIn: false,
    sourcePluginId: pluginId,
    sourcePackId: pack.id,
    createdAt: 0,
    updatedAt: 0,
  }
}

export async function listCharacters(): Promise<Character[]> {
  const dexie = await getDb().characters.orderBy("name").toArray()
  const overlay = listAllPackCharacters().map(({ pack, character, pluginId }) =>
    projectOverlayCharacter(pack, character, pluginId)
  )
  // Dexie wins by id collision (the `cognia-pack:` namespace makes this a
  // defensive belt-and-braces — collisions are physically impossible under
  // the design, but if a malicious manifest somehow registered under a
  // `char_*` id, the persisted Dexie row would still take precedence).
  const byId = new Map<string, Character>()
  for (const row of dexie) byId.set(row.id, row)
  for (const row of overlay) if (!byId.has(row.id)) byId.set(row.id, row)
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
}

export async function getCharacter(id: string): Promise<Character | undefined> {
  return getDb().characters.get(id)
}

/**
 * Two-tier lookup (ADR-0030). Dexie row first (built-ins + user-created +
 * user-cloned), then plugin overlay packs by synthetic id. Returns
 * undefined when neither source has the id — callers (notably
 * `lib/claude/build-options.ts:resolveSendOptions` and the chat header)
 * treat undefined as "character disappeared" and fall back to app
 * defaults, possibly surfacing a banner to the user.
 */
export async function resolveCharacterById(id: string): Promise<Character | undefined> {
  const row = await getCharacter(id)
  if (row) return row
  if (!isOverlayCharacterId(id)) return undefined
  const overlay = getPackCharacterByRuntimeId(id)
  if (!overlay) return undefined
  return projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId)
}

export async function listCharactersByIds(ids: string[]): Promise<Character[]> {
  if (ids.length === 0) return []
  // Split Dexie ids and overlay synthetic ids. We can do a single bulkGet
  // on Dexie ids for efficiency; overlay ids are resolved one at a time
  // from the in-memory registry (it's a Map, so each lookup is O(1)).
  const dexieIds: string[] = []
  const overlayIds: string[] = []
  for (const id of ids) {
    if (isOverlayCharacterId(id)) overlayIds.push(id)
    else dexieIds.push(id)
  }
  const dexieRows = dexieIds.length > 0 ? await getDb().characters.bulkGet(dexieIds) : []
  // Re-index by id so we can splice results back in caller order.
  const byId = new Map<string, Character>()
  for (const row of dexieRows) {
    if (row) byId.set(row.id, row)
  }
  for (const id of overlayIds) {
    const overlay = getPackCharacterByRuntimeId(id)
    if (overlay)
      byId.set(id, projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId))
  }
  const out: Character[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (row) out.push(row)
  }
  return out
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
      | "bareMode"
      | "debugMode"
      | "briefMode"
      | "twinId"
      | "twinSettings"
      | "sourcePluginId"
      | "sourcePackId"
      | "clonedFromPackCharacterId"
      | "packVersionAtClone"
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
    bareMode: draft.bareMode,
    debugMode: draft.debugMode,
    briefMode: draft.briefMode,
    twinId: draft.twinId,
    twinSettings: draft.twinSettings,
    sourcePluginId: draft.sourcePluginId,
    sourcePackId: draft.sourcePackId,
    clonedFromPackCharacterId: draft.clonedFromPackCharacterId,
    packVersionAtClone: draft.packVersionAtClone,
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
  if (isOverlayCharacterId(id)) {
    throw new Error(
      "Plugin-overlay characters are read-only. Duplicate the character first to create an editable copy."
    )
  }
  await getDb().characters.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteCharacter(id: string): Promise<void> {
  if (isOverlayCharacterId(id)) {
    throw new Error(
      "Plugin-overlay characters cannot be deleted. Disable the contributing plugin instead."
    )
  }
  const existing = await getDb().characters.get(id)
  if (existing?.isBuiltIn) {
    throw new Error("Built-in characters cannot be deleted. Duplicate first.")
  }
  await getDb().characters.delete(id)
}

/**
 * Clone a character — Dexie row OR plugin overlay — into a new editable
 * Dexie row. When the source is a plugin overlay, the copy carries
 * `sourcePluginId` / `sourcePackId` / `clonedFromPackCharacterId` /
 * `packVersionAtClone` so the Settings UI can later surface
 * "Update available" when the contributing plugin ships a newer pack
 * version. The copy is never marked as built-in regardless of source.
 */
export async function duplicateCharacter(id: string): Promise<Character> {
  let source: Character | undefined
  let pack: PluginCharacterPackDef | undefined
  let sourcePluginId: string | undefined

  if (isOverlayCharacterId(id)) {
    const overlay = getPackCharacterByRuntimeId(id)
    if (!overlay) throw new Error(`Character ${id} not found`)
    source = projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId)
    pack = overlay.pack
    sourcePluginId = overlay.pluginId
  } else {
    source = await getDb().characters.get(id)
    if (!source) throw new Error(`Character ${id} not found`)
  }

  const now = Date.now()
  const copy: Character = {
    ...source,
    id: newId(),
    name: `${source.name} (copy)`,
    isBuiltIn: false,
    // Overlay-source attribution. For non-overlay sources these stay
    // undefined; for overlay sources they capture the link back to the
    // contributing plugin/pack for the "Update available" comparison.
    sourcePluginId: pack ? sourcePluginId : source.sourcePluginId,
    sourcePackId: pack ? pack.id : source.sourcePackId,
    clonedFromPackCharacterId: pack ? id : source.clonedFromPackCharacterId,
    packVersionAtClone: pack ? pack.version : source.packVersionAtClone,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().characters.put(copy)
  return copy
}

/**
 * Dismiss the "Update available" indicator on a cloned row by snapping
 * `packVersionAtClone` to the current pack version. Used when the user
 * explicitly clicks Dismiss on the badge — they're saying "I'm aware of
 * the new version but choosing to stay on my edited copy". The clone
 * itself stays unchanged; only the comparison cursor moves. (ADR-0030 §D.3)
 *
 * Returns the new pack version on success, or undefined if the row does
 * not look like a clone (no `sourcePluginId` or no `sourcePackId`) or
 * has already been dismissed.
 */
export async function dismissPackUpdate(
  id: string,
  newPackVersion: string
): Promise<string | undefined> {
  const row = await getDb().characters.get(id)
  if (!row || !row.sourcePluginId || !row.sourcePackId) return undefined
  if (row.packVersionAtClone === newPackVersion) return undefined
  await getDb().characters.update(id, {
    packVersionAtClone: newPackVersion,
    updatedAt: Date.now(),
  })
  return newPackVersion
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
    {
      id: "char_builtin_goal_tracker",
      name: "Goal Tracker",
      description:
        "Outcome-driven agent. Pairs with `/goal` to break a fuzzy intent into concrete next steps and self-continues until done.",
      avatarColor: "oklch(0.72 0.16 200)",
      avatarEmoji: "🎯",
      systemPrompt:
        "You are an outcome-driven agent. When the user sets a goal via `/goal`, your default mode is to take concrete steps toward it without asking permission for every decision. Be proactive: pick a first step, do it, report what happened, and decide the next step. Never restate the goal — act on it. When you genuinely cannot proceed without the user, ask one specific question and stop. The judge will treat a clear blocked-with-ask as 'done', so you can pause the loop cleanly when you need input.",
      // `acceptEdits` keeps the auto-continuation loop hands-free —
      // a /goal session that asked for permission every turn would
      // defeat the entire feature.
      permissionMode: "acceptEdits",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
  await db.characters.bulkPut(builtIns)
}
