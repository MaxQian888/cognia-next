// Boot-time hydration hook for the unified shortcut store. Mount once from
// `components/providers/tauri-provider.tsx`. After hydration completes,
// the renderer reads the current bindings from `useShortcutStore` and the
// settings UI mutates them via `bind` / `unbind`.

"use client"

import { useEffect } from "react"
import { useShortcutStore } from "./registry"

export function useSyncShortcutsToRust(): void {
  const hydrated = useShortcutStore((s) => s.hydrated)
  const hydrate = useShortcutStore((s) => s.hydrate)

  useEffect(() => {
    if (hydrated) return
    void hydrate()
  }, [hydrated, hydrate])
}
