"use client"

/**
 * Single source of truth for resolving the user's local profile identity.
 *
 * Precedence: custom profile (`AppSettings.profile`) > credential-derived
 * (active Anthropic account's email prefix) > `null` (callers render their
 * own i18n fallback). Centralised here so the AccountCard, the Profile
 * section, and any future surface agree on the same identity.
 *
 * Writes go through `save()` which read-modify-merges the WHOLE `profile`
 * object before handing it to the serialized settings write queue — a
 * partial patch must never drop sibling profile fields (same clobber class
 * that once wiped `customThemes`, see `lib/db/settings.ts:saveSettings`).
 */

import { useCallback } from "react"

import type { UserProfile } from "@/lib/claude/types"
import { useActiveAnthropicCredential } from "@/lib/subscription/anthropic/hooks"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Pure precedence: custom display name > email prefix > null. */
export function resolveDisplayName(
  profile: UserProfile | undefined,
  email: string | undefined
): string | null {
  const custom = profile?.displayName?.trim()
  if (custom) return custom
  if (email && email.includes("@")) {
    const prefix = email.split("@")[0]
    if (prefix) return prefix
  }
  return null
}

/** Pure accessor; empty string is treated as unset. */
export function resolveAvatarUrl(profile: UserProfile | undefined): string | null {
  return profile?.avatarDataUrl ? profile.avatarDataUrl : null
}

export interface UseUserProfileResult {
  /** The stored profile blob (never null — defaults to `{}`). */
  profile: UserProfile
  /** Whether the settings store finished hydrating. */
  loaded: boolean
  /** Custom > credential-derived > null. */
  resolvedDisplayName: string | null
  /** Custom avatar data URL or null (callers fall back to initials). */
  resolvedAvatarUrl: string | null
  /** Active credential email ("" when signed out). */
  email: string
  /** Whether the credential lookup is still in flight. */
  credentialLoading: boolean
  /** Read-modify-merge patch of the profile blob (bumps `updatedAt`). */
  save: (patch: Partial<UserProfile>) => Promise<void>
}

export function useUserProfile(): UseUserProfileResult {
  const settingsProfile = useSettingsStore((s) => s.settings?.profile)
  const loaded = useSettingsStore((s) => s.loaded)
  const saveSettings = useSettingsStore((s) => s.save)
  const { credential, loading: credentialLoading } = useActiveAnthropicCredential()

  const profile = settingsProfile ?? {}
  const email = credential?.email ?? ""

  const save = useCallback(
    async (patch: Partial<UserProfile>) => {
      // Re-read from the store at call time: the closure's `profile` may be
      // stale when two edits race within one render.
      const current = useSettingsStore.getState().settings?.profile ?? {}
      await saveSettings({ profile: { ...current, ...patch, updatedAt: Date.now() } })
    },
    [saveSettings]
  )

  return {
    profile,
    loaded,
    resolvedDisplayName: resolveDisplayName(profile, email || undefined),
    resolvedAvatarUrl: resolveAvatarUrl(profile),
    email,
    credentialLoading,
    save,
  }
}
