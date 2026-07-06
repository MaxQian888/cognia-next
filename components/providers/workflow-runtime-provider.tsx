"use client"

import { useEffect, useRef } from "react"
import { installTriggerBridge } from "@/lib/workflow/runtime/trigger-bridge"
import {
  initTriggerSubscriptions,
  disposeTriggerSubscriptions,
} from "@/lib/workflow/runtime/trigger-subscriptions"
import {
  initDesktopEventTrigger,
  disposeDesktopEventTrigger,
} from "@/lib/workflow/runtime/desktop-event-trigger"
import {
  initPetEventTrigger,
  disposePetEventTrigger,
} from "@/lib/workflow/runtime/pet-event-trigger"
import { installApprovalNotificationActions } from "@/lib/workflow/runtime/approval-notify"
import { isTauri } from "@/lib/tauri"
import { listWorkflows } from "@/lib/db/workflows"
import { syncWorkflowTriggers } from "@/lib/workflow/runtime/webhook-bridge"
import { resumeInFlightRuns } from "@/lib/workflow/runtime/resume-controller"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

type Disposer = () => void | Promise<void>

/**
 * Top-level provider that boots the workflow runtime once on mount:
 *
 *   1. `installTriggerBridge()` — listens to Tauri `workflow:trigger` events
 *      emitted by the Rust cron daemon + webhook router and routes them to
 *      the orchestrator.
 *   2. Re-sync every workflow's `trigger.cron` / `trigger.webhook` nodes to
 *      the Rust router on boot — the in-memory registry on the Rust side
 *      starts empty, so the first save after launch would otherwise be the
 *      only event Rust knows about.
 *
 * M2 extends this provider with `initTriggerSubscriptions()` for TS-hook
 * trigger flows (chat, connector inbound, goal completion, terminal command).
 *
 * Web mode: all underlying Tauri calls are no-ops, so the provider mounts
 * cleanly but produces no Rust-side state. The sync loop still runs so
 * follow-up Tauri restarts pick up the existing workflow rows.
 */
export function WorkflowRuntimeProvider({ children }: { children?: React.ReactNode }) {
  const disposersRef = useRef<Disposer[]>([])

  useEffect(() => {
    if (typeof window === "undefined") return

    let cancelled = false
    const disposers: Disposer[] = []

    void (async () => {
      try {
        const triggerDisposer = await installTriggerBridge()
        if (cancelled) {
          triggerDisposer()
          return
        }
        disposers.push(triggerDisposer)
        log.info?.("workflow runtime: trigger bridge installed")
      } catch (err) {
        log.warn?.("workflow runtime: installTriggerBridge failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      try {
        initTriggerSubscriptions()
        disposers.push(() => disposeTriggerSubscriptions())
        log.info?.("workflow runtime: trigger subscriptions initialised")
      } catch (err) {
        log.warn?.("workflow runtime: initTriggerSubscriptions failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Live desktop UI events (trigger.desktop.event) ride the Rust
      // automation backend — Tauri-only; web/Capacitor have no event source.
      if (isTauri()) {
        try {
          initDesktopEventTrigger()
          disposers.push(() => disposeDesktopEventTrigger())
          log.info?.("workflow runtime: desktop-event trigger initialised")
        } catch (err) {
          log.warn?.("workflow runtime: initDesktopEventTrigger failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Pet lifecycle events (trigger.pet.event) ride the in-renderer pet
      // event bus — NOT Tauri-gated, the pet runs on web too.
      try {
        initPetEventTrigger()
        disposers.push(() => disposePetEventTrigger())
        log.info?.("workflow runtime: pet-event trigger initialised")
      } catch (err) {
        log.warn?.("workflow runtime: initPetEventTrigger failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Approval-gate notification actions (ADR 0061 P2) — the Approve /
      // Reject buttons on `action.approval.request` notification rows.
      // Not Tauri-gated: the notification center resolves approvals on web
      // too (companion fan-out inside the notifier is Tauri-gated itself).
      try {
        disposers.push(installApprovalNotificationActions())
        log.info?.("workflow runtime: approval notification actions installed")
      } catch (err) {
        log.warn?.("workflow runtime: installApprovalNotificationActions failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      try {
        const all = await listWorkflows()
        await Promise.allSettled(all.map((w) => syncWorkflowTriggers(w)))
        log.info?.("workflow runtime: synced trigger registrations to Rust", {
          count: all.length,
        })
      } catch (err) {
        log.warn?.("workflow runtime: initial trigger sync failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Replay any runs the Rust mirror still holds in-flight — e.g. after a
      // webview crash / reload. Runs AFTER trigger sync so a resumed run sees a
      // fully wired runtime. No-op in web mode (the mirror call returns []), so
      // this is safe on all three shells. Previously `resumeInFlightRuns` was
      // dead code (zero callers), so durable runs never actually resumed.
      try {
        if (!cancelled) {
          const summary = await resumeInFlightRuns()
          if (summary.attempted > 0) {
            log.info?.("workflow runtime: resumed in-flight runs", { ...summary })
          }
        }
      } catch (err) {
        log.warn?.("workflow runtime: resumeInFlightRuns failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      if (!cancelled) {
        disposersRef.current = disposers
      }
    })()

    return () => {
      cancelled = true
      const pending = [...disposersRef.current].reverse()
      disposersRef.current = []
      for (const d of pending) {
        try {
          void d()
        } catch (err) {
          log.warn?.("workflow runtime: disposer threw", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // Also unwind any disposers collected before the ref was assigned.
      const collected = [...disposers].reverse()
      for (const d of collected) {
        if (pending.includes(d)) continue
        try {
          void d()
        } catch {
          // best-effort
        }
      }
    }
  }, [])

  return <>{children}</>
}
