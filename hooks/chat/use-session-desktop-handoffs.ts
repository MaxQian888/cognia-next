"use client"

/**
 * The desktop-only ways a conversation leaves this app for another tool: open
 * it in the terminal (`cognia-agent resume`), dispatch it to the Codex app,
 * bring it back from there — plus the CLI probe that decides whether the
 * terminal item is usable.
 *
 * The conversation sidebar's rows and the conversation manager's rows offer
 * the same row menu (`SessionRowMenuItems`); its `desktop` group is what this
 * hook builds, so the two surfaces cannot drift on wording, gating or errors.
 * Off the desktop shell it returns no `desktop` group, which is how the menu
 * leaves those items out.
 *
 * Heavy collaborators (the transcript export, the terminal store, the Codex
 * dispatcher) stay lazy-loaded behind the handlers.
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import type {
  CogniaAgentStatus,
  SessionRowMenuItemsProps,
} from "@/components/chat/session-row-menu-items"
import { isTauri } from "@/lib/tauri"

const log = loggers.ui

export interface SessionDesktopHandoffs {
  /** Pass to the row menus' `onOpenChange`: opening one probes for the CLI. */
  onActionsOpenChange: (open: boolean) => void
  /** The menu's desktop group; `undefined` off the desktop shell. */
  desktop: SessionRowMenuItemsProps["desktop"]
}

/**
 * @param onReturned Opens the conversation a Codex return landed in — the
 * caller's own way of opening a conversation.
 */
export function useSessionDesktopHandoffs(
  session: ChatSession,
  onReturned: (sessionId: string, event: ReactMouseEvent) => void
): SessionDesktopHandoffs {
  const t = useTranslations("desktop.sessionRow")
  const [cogniaAgentStatus, setCogniaAgentStatus] = useState<CogniaAgentStatus>("unknown")
  const [codexDispatching, setCodexDispatching] = useState(false)
  const latest = useRef({ onReturned })
  useEffect(() => {
    latest.current = { onReturned }
  })

  const handleActionsOpenChange = (open: boolean) => {
    // The terminal hand-off is Tauri-only (its item is not rendered anywhere
    // else), so the CLI probe has nothing to answer on the web.
    if (!open || !isTauri()) return
    if (cogniaAgentStatus === "checking" || cogniaAgentStatus === "available") return
    setCogniaAgentStatus("checking")
    void import("@/lib/cli-bridge/detect-cli")
      .then(({ detectCli }) => detectCli("cognia-agent"))
      .then((result) => setCogniaAgentStatus(result.available ? "available" : "missing"))
      .catch(() => setCogniaAgentStatus("missing"))
  }

  /**
   * Hand this session BACK to the standalone CLI: write its transcript to
   * `~/.cognia/handoff/<id>.jsonl`, then launch `cognia-agent resume <id>` in
   * a fresh dock tab. Desktop only; heavy collaborators stay lazy-loaded.
   */
  const handleOpenInTerminal = () => {
    void (async () => {
      try {
        const [
          { listMessages },
          { exportHandoffToCli },
          { launchCogniaAgent },
          { useTerminalStore },
          { homeDir },
        ] = await Promise.all([
          import("@/lib/db/messages"),
          import("@/lib/chat/export-handoff-to-cli"),
          import("@/lib/terminal/run-cognia"),
          import("@/stores/terminal/terminal-store"),
          import("@tauri-apps/api/path"),
        ])
        const messages = await listMessages(session.id)
        await exportHandoffToCli({ sessionId: session.id, messages })
        const cwd = session.workingDir?.trim() || (await homeDir())
        const outcome = await launchCogniaAgent({
          handoffSessionId: session.id,
          cwd,
          store: useTerminalStore.getState(),
        })
        if (outcome.kind !== "launched") {
          throw new Error(outcome.kind === "error" ? outcome.message : outcome.reason || "denied")
        }
        log.info("session open-in-terminal", { sessionId: session.id })
        toast.success(t("openedInTerminal", { command: `cognia-agent resume ${session.id}` }))
      } catch (err) {
        toast.error(t("openInTerminalFailed"))
        log.warn("session open-in-terminal failed", { error: String(err) })
      }
    })()
  }

  const handleOpenInCodexApp = () => {
    setCodexDispatching(true)
    void import("@/lib/chat/dispatch-to-codex-app")
      .then(({ dispatchSessionToCodexApp }) => dispatchSessionToCodexApp(session))
      .then(() => {
        log.info("session open-in-codex-app", { sessionId: session.id })
        toast.success(t("openedInCodexApp"))
      })
      .catch((error) => {
        log.warn("session open-in-codex-app failed", { error: String(error) })
        const code = (error as { code?: string } | null)?.code
        const detail = String(error)
        toast.error(
          t(
            code === "PII_BLOCKED"
              ? "codexHandoffPiiBlocked"
              : code === "UNTRANSFERABLE_CONTENT"
                ? "codexHandoffUnsupported"
                : detail.includes("uncertain outcome") ||
                    detail.includes("timed out") ||
                    detail.includes("not yet discoverable") ||
                    detail.includes("recovery scan limit")
                  ? "codexHandoffPending"
                  : "openInCodexAppFailed"
          ),
          { description: detail }
        )
      })
      .finally(() => setCodexDispatching(false))
  }

  const handleReturnFromCodexApp = (event: ReactMouseEvent) => {
    setCodexDispatching(true)
    void import("@/lib/chat/dispatch-to-codex-app")
      .then(({ returnSessionFromCodexApp }) => returnSessionFromCodexApp(session))
      .then((sessionId) => {
        latest.current.onReturned(sessionId, event)
        toast.success(t("returnedFromCodexApp"))
      })
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code
        toast.error(
          t(code === "TARGET_NOT_FOUND" ? "codexHandoffTargetMissing" : "returnFromCodexAppFailed"),
          { description: String(error) }
        )
      })
      .finally(() => setCodexDispatching(false))
  }

  return {
    onActionsOpenChange: handleActionsOpenChange,
    desktop: isTauri()
      ? {
          codexDispatching,
          onOpenInCodexApp: handleOpenInCodexApp,
          onReturnFromCodexApp: session.codexHandoff ? handleReturnFromCodexApp : undefined,
          cogniaAgentStatus,
          onOpenInTerminal: handleOpenInTerminal,
        }
      : undefined,
  }
}
