// Editor state shape + helpers shared by `preset-editor.tsx` (the
// orchestrator) and each `editor-sections/*-section.tsx` file. Extracted to
// its own module so section files can import the type without pulling in
// the editor's React tree (and to avoid circular imports between editor
// and sections).

import type {
  AppSettings,
  PresetCategory,
  SendOptions,
  SystemPromptPreset,
} from "@/lib/claude/types"

import { COLOR_PALETTE } from "./editor-sections/constants"

export interface PresetEditorState {
  name: string
  description: string
  icon: string
  color: string
  category: PresetCategory | ""
  content: string
  model: string
  permissionMode: AppSettings["permissionMode"]
  effort: SendOptions["effort"]
  allowedTools: string[]
  disallowedTools: string[]
  mcpServerIds: string[] | undefined
  skillIds: string[]
  agentModeId: string
  workingDir: string
  isDefault: boolean
  isFavorite: boolean
}

export type PresetEditorOutput = Omit<
  Partial<SystemPromptPreset>,
  "id" | "createdAt" | "updatedAt" | "isBuiltIn" | "usageCount" | "lastUsedAt" | "sortOrder"
> & {
  /** Required on save. */
  name: string
  content: string
}

export function emptyEditorState(): PresetEditorState {
  return {
    name: "",
    description: "",
    icon: "✨",
    color: COLOR_PALETTE[0],
    category: "",
    content: "",
    model: "",
    permissionMode: undefined,
    effort: undefined,
    allowedTools: [],
    disallowedTools: [],
    mcpServerIds: undefined,
    skillIds: [],
    agentModeId: "",
    workingDir: "",
    isDefault: false,
    isFavorite: false,
  }
}

export function presetToEditorState(preset: SystemPromptPreset): PresetEditorState {
  return {
    name: preset.name,
    description: preset.description ?? "",
    icon: preset.icon ?? "✨",
    color: preset.color ?? COLOR_PALETTE[0],
    category: preset.category ?? "",
    content: preset.content,
    model: preset.model ?? "",
    permissionMode: preset.permissionMode,
    effort: preset.effort,
    allowedTools: preset.allowedTools ?? [],
    disallowedTools: preset.disallowedTools ?? [],
    mcpServerIds: preset.mcpServerIds,
    skillIds: preset.skillIds ?? [],
    agentModeId: preset.agentModeId ?? "",
    workingDir: preset.workingDir ?? "",
    isDefault: preset.isDefault === true,
    isFavorite: preset.isFavorite === true,
  }
}
