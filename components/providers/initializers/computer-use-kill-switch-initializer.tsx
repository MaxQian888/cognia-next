"use client"

// ADR-0020 W3 — bridge the Rust `automation:kill-switch` event to two
// renderer-side concerns the Rust path can't reach itself:
//
//   1. Drop every chat-side per-session computer-use grant
//      (`clearAllSessionGrants`) so a returning operator doesn't
//      inherit "always allow this session" approvals the previous user
//      accumulated. The Rust ConsentBroker already clears its own
//      grants in the shortcut dispatch — this mirrors that on the chat
//      modal side so both gates are honestly reset.
//   2. Surface a sonner toast so the operator gets visible feedback
//      when the global shortcut (Ctrl+Shift+Alt+K or whatever they
//      bound) fires. Without this, a chord press would be silent and
//      operators wouldn't know whether their key combo actually landed.
//
// Mounted once at the root layout; the listener auto-unsubscribes on
// unmount. No-op in web mode (Tauri events never fire).

import { useEffect } from "react"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"

export function ComputerUseKillSwitchInitializer() {
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      const [{ listen }, { clearAllSessionGrants }] = await Promise.all([
        import("@tauri-apps/api/event"),
        import("@/lib/claude/computer-use-session-grants"),
      ])
      const u = await listen("automation:kill-switch", () => {
        clearAllSessionGrants()
        toast.warning("Automation kill switch engaged", {
          description:
            "Every in-flight call rejected. Session grants cleared on both gates. Re-enable from Settings → Automation.",
        })
      })
      if (cancelled) {
        u()
      } else {
        unlisten = u
      }
    })()
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return null
}

export default ComputerUseKillSwitchInitializer
