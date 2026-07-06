"use client"

/**
 * Reactive source of `@preset:`-mentionable prompt presets for the general
 * chat composer. Picking a preset APPLIES it to the active session (system
 * prompt + model + permission mode + skills …) via `useApplyPreset` — no text
 * is inserted. See `composer.tsx`'s `onPickPopoverItem`.
 *
 * Thin projection over `listPresets()` kept current by `useLiveQuery` so newly
 * created / edited presets surface immediately.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type { SystemPromptPreset } from "@/lib/claude/types"
import { listPresets } from "@/lib/db/prompt-presets"

export function useMentionablePresets(enabled = true): SystemPromptPreset[] {
  const rows = useLiveQuery(() => (enabled ? listPresets() : Promise.resolve([])), [enabled])
  return useMemo(() => rows ?? [], [rows])
}
