"use client"

// Headless mount for the single app-scope keydown dispatcher. Rendered once in
// `app/layout.tsx` (inside the account-gated tree, next to the other global
// initializers) so every renderer surface — web, desktop, and mobile — shares
// one listener for rebindable in-app shortcuts.

import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"

export function AppShortcutDispatcher(): null {
  useAppShortcutDispatcher()
  return null
}

export default AppShortcutDispatcher
