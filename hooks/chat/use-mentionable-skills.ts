"use client"

/**
 * Reactive source of `@skill:`-mentionable skills for the general chat
 * composer. Picking a skill from the `@skill:` panel ENABLES it for the
 * session (it becomes an ephemeral skill chip) rather than inserting text —
 * see `composer.tsx`'s `onPickPopoverItem`.
 *
 * Only ENABLED skills are surfaced (disabled rows would enable to a no-op),
 * mirroring the toolbar `SkillPicker` (`components/chat/skill-picker.tsx`).
 * The list is a thin projection over `listSkills()`; `useLiveQuery` keeps it
 * current as the user adds / removes / toggles skills in Settings.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { listSkills } from "@/lib/db/skills"

/** Minimal skill shape the `@skill:` picker row needs. */
export interface SkillMentionTarget {
  /** Dexie skill id — toggled into `ephemeralSkillIds` on pick. */
  id: string
  /** Display name shown in the picker row + used for fuzzy match. */
  name: string
  /** Optional one-line description shown as the row's trailing meta. */
  description?: string
}

export function useMentionableSkills(enabled = true): SkillMentionTarget[] {
  // Gate the query so the picker only reads Dexie when the combined `@`
  // composer is actually mounted (parity with the subagent / preset hooks).
  const rows = useLiveQuery(() => (enabled ? listSkills() : Promise.resolve([])), [enabled])
  return useMemo(
    () =>
      (rows ?? [])
        .filter((s) => (s.status ?? "enabled") === "enabled")
        .map((s) => ({ id: s.id, name: s.name, description: s.description })),
    [rows]
  )
}
