"use client"

// Mounts the automatic light/dark runner (`useAutoMode`) once at the app root.
// The hook is a no-op until the user enables Settings → Appearance → Auto, so
// this is safe to mount unconditionally. Kept as a thin client shell so the
// (server) root layout can include it without pulling next-themes in directly.

import { useAutoMode } from "@/lib/appearance/use-auto-mode"

export function AutoModeInitializer(): null {
  useAutoMode()
  return null
}

export default AutoModeInitializer
