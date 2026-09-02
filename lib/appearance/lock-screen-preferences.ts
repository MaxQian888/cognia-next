"use client"

/**
 * A boot-safe mirror of the lock-screen appearance.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The lock screen renders BEFORE the account database is open. That is not an
 * ordering accident, it is what a lock screen is for: the database is closed
 * and account-scoped, and opening it is the thing the user is about to
 * authorise. So the settings row that holds the appearance config is, at
 * exactly the moment the lock screen needs it, unreadable.
 *
 * Reading it anyway would have meant importing the settings store into the
 * gate, which drags the whole credential and TTS boot chain into a component
 * that must render on a cold start with nothing initialised.
 *
 * So the appearance is MIRRORED into `localStorage` whenever it changes, from
 * inside the running app where the database is open, and the lock screen reads
 * only the mirror. The mirror is a cache of a preference, never a source of
 * truth: it holds no secrets, and losing it degrades to the default look
 * rather than to a broken screen.
 *
 * The active wallpaper id is mirrored alongside it, because the `wallpaper`
 * backdrop follows whatever the app is currently showing and that id lives in
 * the same unreadable row.
 */

import {
  DEFAULT_LOCK_SCREEN,
  isLockScreenBackdrop,
  type LockScreenSettings,
} from "@/types/appearance/lock-screen"

const STORAGE_KEY = "cognia.lock-screen.appearance.v1"

export interface MirroredLockScreenPreferences {
  settings: LockScreenSettings
  /** The wallpaper the app was showing, for the `wallpaper` backdrop. */
  activeWallpaperId: string | null
}

export const DEFAULT_MIRRORED_PREFERENCES: MirroredLockScreenPreferences = {
  settings: DEFAULT_LOCK_SCREEN,
  activeWallpaperId: null,
}

/**
 * Read the mirror.
 *
 * Never throws. Every failure mode (no storage, disabled storage, malformed
 * JSON, a value written by a newer build) resolves to the defaults, because a
 * lock screen that cannot render is far worse than one that renders plainly.
 */
export function readLockScreenPreferences(): MirroredLockScreenPreferences {
  if (typeof localStorage === "undefined") return DEFAULT_MIRRORED_PREFERENCES
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return DEFAULT_MIRRORED_PREFERENCES
  }
  if (!raw) return DEFAULT_MIRRORED_PREFERENCES

  try {
    const parsed = JSON.parse(raw) as Partial<MirroredLockScreenPreferences>
    const settings = { ...DEFAULT_LOCK_SCREEN, ...(parsed.settings ?? {}) }
    // One field is validated rather than trusted: `backdrop` drives which
    // branch renders, so an unrecognised value would fall through every case
    // and leave the screen with no backdrop at all.
    if (!isLockScreenBackdrop(settings.backdrop)) settings.backdrop = DEFAULT_LOCK_SCREEN.backdrop
    return {
      settings,
      activeWallpaperId:
        typeof parsed.activeWallpaperId === "string" ? parsed.activeWallpaperId : null,
    }
  } catch {
    return DEFAULT_MIRRORED_PREFERENCES
  }
}

/** Write the mirror. Silently gives up where storage is unavailable. */
export function writeLockScreenPreferences(value: MirroredLockScreenPreferences): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // A full or disabled quota costs the customisation, not the lock screen.
  }
}

/** Drop the mirror. Used when the last account is removed. */
export function clearLockScreenPreferences(): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do, and nothing that depends on it succeeding.
  }
}
