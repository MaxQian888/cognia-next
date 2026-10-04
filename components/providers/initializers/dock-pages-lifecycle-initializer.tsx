"use client"

/**
 * Turns on the chat dock's page tabs for the desktop shell (ADR-0214, D8 /
 * D10), once, for the life of the app:
 *
 * - `startDockPageSync` mirrors the shared Chromium session's pages into the
 *   conversations' page tabs — an agent's new tab, a popup, a page that closed
 *   itself — and lets an agent's first page fill the tab on screen;
 * - `subscribeDockPageLifecycle` closes a conversation's pages when the user
 *   leaves it, or when its run settles if it was still running (D10);
 * - `configureAgentPageOwnership` tells agent routing which conversation is on
 *   screen, so an External Bridge client's pages appear there;
 * - `primeLocalBrowserRouting` reads whether Chromium is installed before the
 *   first agent call or tab menu needs to know.
 *
 * Only the desktop runs Cognia's own Chromium, so nothing is wired elsewhere.
 * Renders nothing; mounted once in `components/runtime/app-runtime.tsx`.
 */

import { useEffect } from "react"

import { startDockPageSync, subscribeDockPageLifecycle } from "@/lib/artifacts/dock-pages"
import { configureAgentPageOwnership, primeLocalBrowserRouting } from "@/lib/browser/agent-engine"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"

export function DockPagesLifecycleInitializer() {
  useEffect(() => {
    if (!isTauri()) return
    configureAgentPageOwnership({
      activeChatSessionId: () => useChatStore.getState().activeSessionId,
    })
    void primeLocalBrowserRouting()
    const stopSync = startDockPageSync()
    const stopLifecycle = subscribeDockPageLifecycle()
    return () => {
      stopLifecycle()
      stopSync()
      configureAgentPageOwnership(null)
    }
  }, [])
  return null
}

export default DockPagesLifecycleInitializer
