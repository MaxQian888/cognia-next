"use client"

/**
 * IslandView — root of the `/island` route rendered inside the frameless,
 * transparent, always-on-top "island" Tauri window. Mirrors PetOverlayView's
 * contract: mark `<html data-island-overlay>` so the page paints transparent
 * (globals.css), then reveal the hidden window after the first painted frame
 * (`schedulePetWindowReveal` — shared with the pet windows; it operates on
 * "the current window", so it needs no pet-specific state).
 */

import { useEffect } from "react"
import { IslandShell } from "./island-shell"
import { schedulePetWindowReveal } from "@/lib/pet/reveal"

export function IslandView() {
  useEffect(() => {
    document.documentElement.setAttribute("data-island-overlay", "true")
    const cancelReveal = schedulePetWindowReveal()
    return () => {
      document.documentElement.removeAttribute("data-island-overlay")
      cancelReveal()
    }
  }, [])

  return (
    <div className="flex min-h-0 items-start justify-center" data-testid="island-view">
      <IslandShell />
    </div>
  )
}

export default IslandView
