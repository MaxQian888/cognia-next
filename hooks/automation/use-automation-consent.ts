"use client"

/**
 * Automation HITL consent stream (transport-agnostic).
 *
 * Subscribes to the `automation:consent-request` channel — emitted host-side by
 * `ConsentBroker::request` (`src-tauri/src/automation/consent.rs`) when a
 * computer-use action hits the `PerCall` permission tier, and forwarded to
 * paired devices over `/ws/v1/events` (`companion_api/commands.rs`
 * `register_tauri_event`). Each prompt is queued (dedupe by broker id, since a
 * WS reconnect can replay a frame) with a renderer-side countdown, and
 * resolved through `desktop.consentRespond` → `automation_consent_respond`.
 *
 * `transport.subscribe` / `transport.call` route over Tauri IPC on desktop and
 * the companion WS / `/api/v1/_rpc/*` on mobile, so this hook is platform
 * neutral. The mobile consent sheet is its only consumer today; the desktop
 * `<ConsentOverlay>` keeps its own Tauri-`listen` path. Logic mirrors that
 * overlay (`components/automation/consent-overlay.tsx`) so the two stay in step.
 *
 * Pass `enabled: false` to skip the subscription entirely (e.g. an observe-only
 * device that may not resolve consent).
 */

import { useCallback, useEffect, useState } from "react"

import { transport } from "@/lib/tauri"
import {
  desktop,
  type ConsentPromptPayload,
  type ConsentRequestEvent,
} from "@/lib/automation/client"

const CONSENT_EVENT = "automation:consent-request"

export interface PendingConsent extends ConsentRequestEvent {
  /** Wall-clock deadline for the renderer-side countdown. */
  expiresAt: number
}

export interface AutomationConsentStream {
  /** Queued prompts awaiting a decision, oldest first. */
  queue: PendingConsent[]
  /** Monotonic clock (ms) so a consumer can render the auto-reject countdown. */
  now: number
  /** Resolve a prompt. `persist` = "always allow this session" for the tuple. */
  respond: (event: PendingConsent, allow: boolean, persist: boolean) => Promise<void>
}

function promptOnly(event: ConsentRequestEvent): ConsentPromptPayload {
  return {
    command: event.command,
    surface: event.surface,
    pluginId: event.pluginId,
    processName: event.processName,
    windowTitle: event.windowTitle,
  }
}

export function useAutomationConsent({ enabled }: { enabled: boolean }): AutomationConsentStream {
  const [queue, setQueue] = useState<PendingConsent[]>([])
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    const unsub = transport.subscribe<ConsentRequestEvent>(CONSENT_EVENT, (payload) => {
      setQueue((prev) => {
        // Dedupe by id — a WS reconnect replays frames since the last cursor.
        if (prev.some((p) => p.id === payload.id)) return prev
        return [...prev, { ...payload, expiresAt: Date.now() + payload.timeoutMs }]
      })
    })
    return unsub
  }, [enabled])

  // 0.5s tick drives the countdown + drops expired prompts inline. The Rust
  // broker enforces the real 30s timeout — this is UI tidy-up only.
  useEffect(() => {
    if (queue.length === 0) return
    const id = window.setInterval(() => {
      const ts = Date.now()
      setNow(ts)
      setQueue((prev) => prev.filter((p) => p.expiresAt > ts - 1000))
    }, 500)
    return () => window.clearInterval(id)
  }, [queue.length])

  const respond = useCallback(async (event: PendingConsent, allow: boolean, persist: boolean) => {
    // Optimistically dequeue so the user can't double-tap a decision.
    setQueue((prev) => prev.filter((p) => p.id !== event.id))
    try {
      await desktop.consentRespond({
        id: event.id,
        allow,
        persist,
        prompt: persist ? promptOnly(event) : undefined,
      })
    } catch (err) {
      // Best-effort — if this never lands, the Rust broker's timeout fires.
      console.warn("automation_consent_respond failed", err)
    }
  }, [])

  return { queue, now, respond }
}
