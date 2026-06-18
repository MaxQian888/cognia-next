// Sanitize a portable Discover item (character / skill / team / workflow
// template) into a self-contained, shareable definition, then PII-gate and
// optionally redact it before it leaves the device.
//
// Only *definition* kinds are shareable — never config/credentials
// (plugin / mcpServer / connector / ocrProvider) and never personal data
// (twinSource / twinDraft). The serialized JSON is the `discover-item`
// SharePayload body; the public viewer (`payload-view.tsx`) re-parses it.

import { hasNoLeakingPii, redactText } from "@/lib/twin/ingest/redact"
import type { Character, Skill, Team } from "@/lib/claude/types"
import type { WorkflowCopilotTemplate } from "@/lib/workflow/copilot-templates"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

export type ShareableDiscoverKind = "character" | "skill" | "team" | "workflowTemplate"

interface SharedBase {
  /** Portable display name, resolved to the sharer's locale where bilingual. */
  name: string
  description?: string
}

export interface SharedCharacterDef extends SharedBase {
  kind: "character"
  systemPrompt: string
  model?: string
  avatarEmoji?: string
}

export interface SharedSkillDef extends SharedBase {
  kind: "skill"
  content: string
  tags?: string[]
  allowedTools?: string[]
}

export interface SharedTeamMemberDef {
  role?: string
  systemPromptOverride?: string
}

export interface SharedTeamDef extends SharedBase {
  kind: "team"
  orchestration: string
  members: SharedTeamMemberDef[]
}

export interface SharedTemplateSlotDef {
  key: string
  type: string
  label: string
  description?: string
  required?: boolean
  options?: string[]
}

export interface SharedWorkflowTemplateDef extends SharedBase {
  kind: "workflowTemplate"
  tags?: string[]
  slots: SharedTemplateSlotDef[]
}

export type SharedDiscoverDefinition =
  | SharedCharacterDef
  | SharedSkillDef
  | SharedTeamDef
  | SharedWorkflowTemplateDef

type Locale = "en" | "zh-CN"

function pickLocale(value: { en: string; "zh-CN": string }, locale: Locale): string {
  return value[locale] ?? value.en
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function sanitizeCharacter(c: Character): SharedCharacterDef {
  return {
    kind: "character",
    name: c.name,
    description: trimOrUndefined(c.description),
    systemPrompt: c.systemPrompt,
    model: c.model,
    avatarEmoji: c.avatarEmoji,
  }
}

function sanitizeSkill(s: Skill): SharedSkillDef {
  return {
    kind: "skill",
    name: s.name,
    description: trimOrUndefined(s.description),
    content: s.content,
    tags: s.tags?.length ? [...s.tags] : undefined,
    allowedTools: s.allowedTools?.length ? [...s.allowedTools] : undefined,
  }
}

function sanitizeTeam(t: Team): SharedTeamDef {
  // Members keep only descriptive fields: local characterId / model / tool /
  // MCP references don't survive export, so they're dropped (the viewer notes
  // the roster is descriptive, not importable).
  return {
    kind: "team",
    name: t.name,
    description: trimOrUndefined(t.description),
    orchestration: t.orchestration,
    members: t.members.map((m) => ({
      role: trimOrUndefined(m.role),
      systemPromptOverride: trimOrUndefined(m.systemPromptOverride),
    })),
  }
}

function sanitizeWorkflowTemplate(
  t: WorkflowCopilotTemplate,
  locale: Locale
): SharedWorkflowTemplateDef {
  // Drop the `build()` function — only the declarative shape is portable.
  return {
    kind: "workflowTemplate",
    name: pickLocale(t.label, locale),
    description: trimOrUndefined(pickLocale(t.description, locale)),
    tags: t.tags?.length ? [...t.tags] : undefined,
    slots: t.slots.map((slot) => ({
      key: slot.key,
      type: slot.type,
      label: pickLocale(slot.label, locale),
      description: slot.description
        ? trimOrUndefined(pickLocale(slot.description, locale))
        : undefined,
      required: slot.required,
      options: slot.options?.length ? [...slot.options] : undefined,
    })),
  }
}

/** True for the four definition kinds that may be shared. */
export function isShareableDiscoverItem(item: DiscoverItem): boolean {
  return (
    item.kind === "character" ||
    item.kind === "skill" ||
    item.kind === "team" ||
    item.kind === "workflowTemplate"
  )
}

/**
 * Project a selected Discover item into a portable, sanitized definition.
 * Returns null for any non-shareable kind.
 */
export function buildSharedDefinition(
  item: DiscoverItem,
  locale: Locale = "en"
): SharedDiscoverDefinition | null {
  switch (item.kind) {
    case "character":
      return sanitizeCharacter(item.data)
    case "skill":
      return sanitizeSkill(item.data)
    case "team":
      return sanitizeTeam(item.data)
    case "workflowTemplate":
      return sanitizeWorkflowTemplate(item.data, locale)
    default:
      return null
  }
}

/** Stable JSON serialization used as the share payload body. */
export function serializeSharedDefinition(def: SharedDiscoverDefinition): string {
  return JSON.stringify(def)
}

/** True when the sanitized definition still carries recognised PII. */
export function definitionHasPii(def: SharedDiscoverDefinition): boolean {
  return !hasNoLeakingPii(serializeSharedDefinition(def))
}

/**
 * Redact PII out of the definition by scrubbing its serialized form and
 * re-parsing. All definition fields are strings / string arrays, so the
 * redacted JSON stays valid (placeholders are plain `<KIND_NNN>` text).
 */
export function redactSharedDefinition(def: SharedDiscoverDefinition): SharedDiscoverDefinition {
  const redacted = redactText(serializeSharedDefinition(def)).redacted
  return JSON.parse(redacted) as SharedDiscoverDefinition
}
