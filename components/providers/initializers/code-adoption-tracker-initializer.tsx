"use client"

/**
 * Boot initializer for the local code-adoption tracker (Phase 1). Mounted in
 * the main desktop window inside `DesktopOnlyInitializers` (already gated to
 * Tauri + main window). Subscribes to the chat store's turn lifecycle once and
 * persists each settled turn's write-attribution to Dexie via the Rust
 * `code_adoption` engine. `startCodeAdoptionTracker` self-no-ops off Tauri, so
 * this is inert everywhere else.
 */

import { useEffect } from "react"

import { startCodeAdoptionTracker } from "@/lib/code-adoption/turn-tracker"

export function CodeAdoptionTrackerInitializer() {
  useEffect(() => startCodeAdoptionTracker(), [])
  return null
}

export default CodeAdoptionTrackerInitializer
