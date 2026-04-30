// Shared enum values for the Claude model picker and permission-mode picker
// used across settings sections (general, characters, presets/preset-editor).
// Display labels are sourced from i18n (`settings.general.model.*` and
// `settings.general.permission.*`) — this file holds only the canonical values.

import type { AppSettings } from "@/lib/claude/types"

export const MODEL_PRESET_VALUES = [
  "claude-opus-4-7",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const

export type ModelPresetValue = (typeof MODEL_PRESET_VALUES)[number]

export const PERMISSION_MODE_VALUES: NonNullable<AppSettings["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]

export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number]
