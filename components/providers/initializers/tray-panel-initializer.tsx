"use client"

/**
 * Main-window half of the tray quick panel.
 *
 * The panel window resolves an action and emits `tray-panel://run`; everything
 * that actually touches the app happens here, because this is the window that
 * owns the chat stores, the router, the slash-command dispatcher and the plugin
 * command registry. Native actions never reach this file — the panel sends
 * those straight to Rust (`tray_run_native_action`), which already implements
 * them for the OS menu.
 *
 * It also answers `tray-panel://state-request`: the panel is a least-privilege
 * webview with no Dexie and no stores, so it cannot build the
 * `TrayStateSnapshot` its `when` expressions are evaluated against, and asks
 * the window that already maintains one.
 */

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { startNewSession } from "@/lib/chat/start-session"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { handleTrayUsageCommand } from "@/lib/tray/dispatcher"
import { dispatchSlashCommand } from "@/lib/slash-commands/registry"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import {
  onTrayPanelRequest,
  onTrayPanelStateRequest,
  sendTrayPanelResult,
  sendTrayPanelState,
} from "@/lib/tauri/tray-panel"
import { useTrayStateSnapshot } from "@/lib/tray/state-snapshot"
import type { TrayPanelResolvedEffect, TrayPanelRunRequest } from "@/lib/tray-panel/types"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useUIStore } from "@/stores/ui"

/**
 * Land a delegated prompt in a conversation.
 *
 * Reuses the composer-intent seam the selection toolbar already goes through
 * (`stores/chat/composer-intent-store`) rather than calling the sidecar
 * directly: that path persists the user message, applies the session's send
 * options, and shows the turn in the UI — all of which a raw `sendPrompt` from
 * outside the chat hook would skip.
 */
async function delegate(
  effect: Extract<TrayPanelResolvedEffect, { kind: "delegate" }>,
  requestId: string,
  router: { push: (path: string) => void }
): Promise<void> {
  const active = useChatStore.getState().activeSessionId
  const sessionId =
    effect.target === "activeSession" && active ? active : (await startNewSession()).id

  // `setActiveSession` is idempotent, and a freshly created session is already
  // active — but a reused one may not be if the delegate arrived while the user
  // was looking at something else.
  useChatStore.getState().setActiveSession(sessionId)
  useUIStore.getState().setSelectedGuild({ kind: "dm" })

  useComposerIntentStore.getState().stage(sessionId, {
    candidateId: requestId,
    prompt: effect.prompt,
    autoSend: effect.autoSend,
  })
  router.push("/")
}

export function TrayPanelInitializer() {
  const router = useRouter()
  const t = useTranslations("trayPanel")
  // The translator isn't a stable reference, so it rides in a ref rather than
  // in the effect deps — depending on it would tear down and rebuild every
  // listener on a locale change.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  // Live snapshot, maintained by the same hook the tray menu's `when` filtering
  // uses. Held in a ref so a state change doesn't re-subscribe the listeners.
  const snapshot = useTrayStateSnapshot()
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    // Rust broadcasts nothing here, but `emitTo("main", …)` still reaches every
    // webview whose window is labelled "main" — and this component is bundled
    // with the desktop initializers, which the overlay windows skip. Guarding
    // anyway: delegating a task is not idempotent, and a second execution would
    // create a second conversation.
    if (!isMainAppWindow()) return

    let alive = true
    const unlistens: Array<() => void> = []

    const runEffect = async (request: TrayPanelRunRequest): Promise<void> => {
      const effect = request.effect
      switch (effect.kind) {
        case "delegate":
          await delegate(effect, request.requestId, router)
          return
        case "slash":
          await dispatchSlashCommand(effect.line)
          return
        case "command": {
          // Tray-internal ids (usage refresh, metric/period/scope pins) never
          // enter the unified command registry, because their rows are
          // synthesized per menu build. Route them the same way the tray menu
          // does before falling through to the registry, so the quick panel's
          // Refresh button and the menu's Refresh row are literally one path.
          if (handleTrayUsageCommand(effect.commandId)) return
          if (!getCommand(effect.commandId)) {
            throw new Error(tRef.current("errors.unknownCommand", { id: effect.commandId }))
          }
          await executeCommand(effect.commandId)
          return
        }
        case "navigate":
          router.push(effect.path)
          return
        case "native":
          // Handled in Rust, straight from the panel. Reaching here means a
          // stale panel build is still routing natives through the main window.
          throw new Error(tRef.current("errors.unknownCommand", { id: effect.action }))
      }
    }

    const handle = (request: TrayPanelRunRequest) => {
      void (async () => {
        try {
          await runEffect(request)
          if (alive) void sendTrayPanelResult({ requestId: request.requestId, ok: true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!alive) return
          // The panel is normally already dismissed, so the failure has to land
          // somewhere the user will actually see it.
          toast.error(tRef.current("errors.runFailedFor", { action: request.actionLabel }), {
            description: message,
          })
          void sendTrayPanelResult({
            requestId: request.requestId,
            ok: false,
            error: message,
          })
        }
      })()
    }

    void Promise.all([
      onTrayPanelRequest(handle).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
      onTrayPanelStateRequest(() => {
        if (alive) void sendTrayPanelState(snapshotRef.current)
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
    ])

    return () => {
      alive = false
      unlistens.forEach(safeUnlisten)
    }
  }, [router])

  return null
}

export default TrayPanelInitializer
