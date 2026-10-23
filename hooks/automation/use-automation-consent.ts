"use client"

/**
 * Automation HITL consent stream (transport-agnostic).
 *
 * Subscribes to the `automation:consent-request` channel — emitted host-side by
 * `ConsentBroker::request` (`src-tauri/src/automation/consent.rs`) when a
 * computer-use action hits the `PerCall` permission tier, and forwarded to
 * paired devices over `/ws/events` (`companion_api/commands.rs`
 * `register_tauri_event`). Each prompt is queued (dedupe by broker id, since a
 * WS reconnect can replay a frame) with a renderer-side countdown, and
 * resolved through `desktop.consentRespond` → `automation_consent_respond`.
 *
 * `transport.subscribe` / `transport.call` route over Tauri IPC on desktop and
 * the companion WS / `/api/_rpc/*` on mobile, so this hook is platform
 * neutral. Both consent surfaces run on it: the desktop `<ConsentOverlay>`
 * (`components/automation/consent-overlay.tsx`) and the mobile
 * `<MobileConsentSheet>`. They used to hold two copies of this queue, which had
 * already drifted (only the overlay's copy forwarded `commandDetail`).
 *
 * Pass `enabled: false` to skip the subscription entirely (e.g. an observe-only
 * device that may not resolve consent).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { transport } from "@/lib/tauri"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { desktop, type ConsentRequestEvent } from "@/lib/automation/client"
import {
  CONSENT_REQUEST_EVENT,
  consentPromptOf,
  getConsentRoutingVersion,
  isConsentRoutedElsewhere,
  isConsentSettled,
  markConsentSettled,
  subscribeConsentRouting,
} from "@/lib/automation/consent-routing"

function consentSource() {
  return getActiveRemoteTransport() ?? transport
}

function subscribeConsentSource(listener: () => void) {
  const offTransport = onTransportChange(listener)
  const offRemote = subscribeActiveRemoteTransport(listener)
  return () => {
    offTransport()
    offRemote()
  }
}

export interface PendingConsent extends ConsentRequestEvent {
  /** Wall-clock deadline for the renderer-side countdown. */
  expiresAt: number
}

export interface AutomationConsentStream {
  /** Queued prompts awaiting a decision, oldest first. */
  queue: PendingConsent[]
  /** Monotonic clock (ms) so a consumer can render the auto-reject countdown. */
  now: number
  /**
   * Resolve a prompt. `persist` = "don't ask again for this tuple", bounded by
   * `grantDurationMs` (the broker defaults and clamps it — see
   * `lib/automation/consent-durations.ts`).
   */
  respond: (
    event: PendingConsent,
    allow: boolean,
    persist: boolean,
    grantDurationMs?: number
  ) => Promise<void>
}

export function useAutomationConsent({
  enabled,
  honorRouting = false,
}: {
  enabled: boolean
  /**
   * Hide prompts another window has claimed or already answered
   * (`lib/automation/consent-routing.ts`). The main desktop overlay sets it;
   * the claim is only ever taken in the main window's runtime.
   */
  honorRouting?: boolean
}): AutomationConsentStream {
  const source = useSyncExternalStore(subscribeConsentSource, consentSource, consentSource)
  const binding = useMemo(() => ({ source, enabled }), [source, enabled])
  const activeBinding = useRef<typeof binding | null>(null)
  const [state, setState] = useState<{ binding: typeof binding | null; queue: PendingConsent[] }>({
    binding: null,
    queue: [],
  })
  const queue = enabled && state.binding === binding ? state.queue : []
  const routingVersion = useSyncExternalStore(
    subscribeConsentRouting,
    getConsentRoutingVersion,
    getConsentRoutingVersion
  )
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    activeBinding.current = binding
    let disposed = false
    const current = () => !disposed && consentSource() === source
    const receive = (events: ConsentRequestEvent[], budgetStartedAt: number) => {
      if (!current() || events.length === 0) return
      const receivedAt = Date.now()
      setNow(receivedAt)
      setState((prev) => {
        const next = prev.binding === binding ? [...prev.queue] : []
        for (const payload of events) {
          if (isConsentSettled(payload.id)) continue
          const expiresAt = budgetStartedAt + payload.timeoutMs
          const index = next.findIndex((prompt) => prompt.id === payload.id)
          if (index >= 0) {
            next[index] = { ...next[index], expiresAt: Math.min(next[index].expiresAt, expiresAt) }
          } else if (expiresAt > receivedAt) {
            next.push({ ...payload, expiresAt })
          }
        }
        return {
          binding,
          queue: next.filter(
            (prompt) => prompt.expiresAt > receivedAt && !isConsentSettled(prompt.id)
          ),
        }
      })
    }
    // Subscribe before reading the snapshot: neither side of the async listen
    // boundary can lose the first request. This reads; it never retries actions.
    const unsub = source.subscribe<ConsentRequestEvent>(CONSENT_REQUEST_EVENT, (payload) =>
      receive([payload], Date.now())
    )
    void (async () => {
      try {
        await source.whenSubscribed?.([CONSENT_REQUEST_EVENT])
        if (!current()) return
        const startedAt = Date.now()
        const pending = await desktop.consentPending()
        // The broker returns remaining time. Anchor before the RPC so transit
        // time cannot extend its deadline.
        receive(pending, startedAt)
      } catch (err) {
        if (current()) console.warn("automation_consent_pending failed", err)
      }
    })()
    return () => {
      disposed = true
      if (activeBinding.current === binding) activeBinding.current = null
      unsub()
    }
  }, [enabled, source, binding])

  // 0.5s tick drives the countdown + drops expired prompts inline. The Rust
  // broker enforces the real timeout (`AutomationSettings.consentTimeoutMs`,
  // echoed on each frame as `timeoutMs`) — this is UI tidy-up only.
  useEffect(() => {
    if (queue.length === 0) return
    const id = window.setInterval(() => {
      const ts = Date.now()
      setNow(ts)
      setState((prev) =>
        prev.binding === binding
          ? { binding, queue: prev.queue.filter((p) => p.expiresAt > ts - 1000) }
          : prev
      )
    }, 500)
    return () => window.clearInterval(id)
  }, [queue.length, binding])

  const respond = useCallback(
    async (event: PendingConsent, allow: boolean, persist: boolean, grantDurationMs?: number) => {
      if (
        !enabled ||
        activeBinding.current !== binding ||
        consentSource() !== source ||
        isConsentSettled(event.id) ||
        event.expiresAt <= Date.now()
      )
        return
      // Optimistically dequeue so the user can't double-tap a decision.
      markConsentSettled(event.id)
      setState((prev) =>
        prev.binding === binding
          ? { binding, queue: prev.queue.filter((p) => p.id !== event.id) }
          : prev
      )
      try {
        await desktop.consentRespond({
          id: event.id,
          allow,
          persist,
          prompt: persist ? consentPromptOf(event) : undefined,
          grantDurationMs: persist ? grantDurationMs : undefined,
        })
      } catch (err) {
        // Best-effort — if this never lands, the Rust broker's timeout fires.
        console.warn("automation_consent_respond failed", err)
      }
    },
    [enabled, binding, source]
  )

  const visible = useMemo(
    () => (honorRouting ? queue.filter((prompt) => !isConsentRoutedElsewhere(prompt)) : queue),
    // `routingVersion` is the external store's snapshot: a claim or a settle
    // elsewhere must re-filter even though `queue` did not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [honorRouting, queue, routingVersion]
  )

  return { queue: visible, now, respond }
}
