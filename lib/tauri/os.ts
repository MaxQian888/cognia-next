"use client"

import {
  arch as archNative,
  family as familyNative,
  hostname as hostnameNative,
  locale as localeNative,
  platform as platformNative,
  type as typeNative,
  version as versionNative,
} from "@tauri-apps/plugin-os"
import { isTauri } from "@/lib/tauri"

export interface OsInfo {
  platform: string
  osType: string
  family: string
  arch: string
  version: string
  hostname: string | null
  locale: string | null
}

/**
 * Bundle of OS facts useful for the About dialog and conditional UI (e.g.
 * showing ⌘ vs Ctrl in keyboard hints). Returns null outside Tauri.
 */
export async function getOsInfo(): Promise<OsInfo | null> {
  if (!isTauri()) return null
  try {
    const [platform, osType, family, arch, version, hostname, locale] = await Promise.all([
      Promise.resolve(platformNative()),
      Promise.resolve(typeNative()),
      Promise.resolve(familyNative()),
      Promise.resolve(archNative()),
      Promise.resolve(versionNative()),
      hostnameNative(),
      localeNative(),
    ])
    return { platform, osType, family, arch, version, hostname, locale }
  } catch (err) {
    console.warn("getOsInfo failed", err)
    return null
  }
}

/** Quick check for "is the user on macOS" — drives ⌘ vs Ctrl shortcut hints. */
export function isMacPlatform(): boolean {
  if (!isTauri()) {
    return typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
  }
  try {
    return platformNative() === "macos"
  } catch {
    return false
  }
}
