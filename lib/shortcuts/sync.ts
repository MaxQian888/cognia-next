// Boot-time hydration hook for the unified shortcut store. Mount once from
// `components/providers/tauri-provider.tsx`. After hydration completes,
// the renderer reads the current bindings from `useShortcutStore` and the
// settings UI mutates them via `bind` / `unbind`.

"use client"

import { useEffect } from "react"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { useShortcutStore } from "./registry"

export function useSyncShortcutsToRust(): void {
  const hydrated = useShortcutStore((s) => s.hydrated)
  const hydrate = useShortcutStore((s) => s.hydrate)

  useEffect(() => {
    // Hydration reads `shortcuts.custom.v1` via the shared store plugin, which
    // least-privilege pet windows can't load (see
    // `src-tauri/capabilities/pet.json`). Only the main window owns shortcuts.
    if (hydrated || !isMainAppWindow()) return
    void hydrate()
  }, [hydrated, hydrate])
}
