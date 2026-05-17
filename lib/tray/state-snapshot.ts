// Reactive `TrayStateSnapshot` for the sync hook. Combines:
//
//   - `useChatStore`        → chat.streaming, chat.hasActiveSession
//   - Dexie `goals` table   → goal.active, goal.paused (via `useLiveQuery`;
//                              transitions fired by the goal runtime's
//                              pause/resume/stop paths in
//                              `lib/goal/runtime.ts` write to IndexedDB and
//                              automatically wake us up)
//   - `automation:event` /  → automation.running (true while events arrive
//     `automation:kill-switch`  within ACTIVITY_WINDOW_MS), automation.armed
//                              (flips false once the kill switch fires)
//   - navigator             → platform.os
//
// Anything that observably changes drives the sync hook to push a fresh DTO
// to Rust. The fallback `defaultSnapshot()` lives in `sync.ts` for tests
// that don't mount a provider tree.

"use client"

import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { useLiveQuery } from "dexie-react-hooks"
import { useChatStore } from "@/stores/chat"
import { getOpenGoalForSession } from "@/lib/db/goals"
import { isTauri } from "@/lib/tauri"

import type { TrayStateSnapshot } from "./types"

const ACTIVITY_WINDOW_MS = 8_000

function detectOs(): TrayStateSnapshot["platform"]["os"] {
  if (typeof navigator === "undefined" || !navigator.platform) return "unknown"
  const p = navigator.platform.toLowerCase()
  if (p.includes("win")) return "windows"
  if (p.includes("mac")) return "macos"
  if (p.includes("linux")) return "linux"
  return "unknown"
}

interface AutomationState {
  running: boolean
  armed: boolean
}

export function useTrayStateSnapshot(): TrayStateSnapshot {
  const status = useChatStore((s) => s.status)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // Live goal subscription via Dexie's `useLiveQuery` — fires on every
  // pause / resume / stop / preempt the goal runtime writes to IndexedDB.
  // Returns the most recent open (non-terminal) goal for the session, or
  // `null` when there's no active session yet.
  const openGoal = useLiveQuery(
    async () => (activeSessionId ? ((await getOpenGoalForSession(activeSessionId)) ?? null) : null),
    [activeSessionId],
    null
  )
  const goal = {
    active: openGoal?.status === "active",
    paused: openGoal?.status === "paused",
  }

  const [automation, setAutomation] = useState<AutomationState>({
    running: false,
    armed: true,
  })
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    const offHandles: Array<() => void> = []

    function markRunning() {
      if (cancelled) return
      setAutomation((prev) => (prev.running ? prev : { ...prev, running: true }))
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = setTimeout(() => {
        if (cancelled) return
        setAutomation((prev) => ({ ...prev, running: false }))
      }, ACTIVITY_WINDOW_MS)
    }

    void listen("automation:event", markRunning).then((off) => {
      if (cancelled) off()
      else offHandles.push(off)
    })
    void listen("automation:consent-request", markRunning).then((off) => {
      if (cancelled) off()
      else offHandles.push(off)
    })
    void listen("automation:kill-switch", () => {
      if (cancelled) return
      setAutomation({ running: false, armed: false })
    }).then((off) => {
      if (cancelled) off()
      else offHandles.push(off)
    })

    return () => {
      cancelled = true
      if (activityTimer) clearTimeout(activityTimer)
      for (const off of offHandles) {
        try {
          off()
        } catch {
          /* unsubscribe failure is non-fatal */
        }
      }
    }
  }, [])

  return {
    goal,
    automation,
    chat: {
      streaming: status === "streaming",
      hasActiveSession: !!activeSessionId,
    },
    platform: { os: detectOs() },
  }
}
