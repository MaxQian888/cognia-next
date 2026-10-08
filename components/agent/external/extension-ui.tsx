"use client"

import { useEffect, useState, type ReactNode } from "react"
import Ansi from "ansi-to-react"
import { InfoIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type {
  ExternalAgentUiState,
  ExternalAgentInputQueueClearedEvent,
} from "@/types/agent/external-agent"
import {
  createExternalAgentUiState,
  reduceExternalAgentUiState,
} from "@/lib/ai/agent/external/session/extension-ui-state"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"

type SessionLink = { agentId: string; sessionId: string }

/**
 * How long an info notice stays on the strip. Info is what an extension says
 * in passing ("RTK rewrite: ls -> rtk ls", one per tool call), so it is shown
 * where the user is already looking and then gets out of the way, instead of
 * stacking a toast per call over the conversation.
 */
export const EXTENSION_NOTICE_MS = 6000

/**
 * ANSI control sequences (CSI: colours, cursor moves). Extensions write for a
 * terminal, so their text arrives styled for one; where a plain string is
 * needed (a tooltip, the title) the styling is dropped. Built from a char code
 * because a literal ESC in a regex is a lint error.
 */
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

/** Extension text with its terminal styling removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "")
}

/** Ephemeral extension UI around the actual composer; built-in chats never load a runtime. */
export function ExternalAgentExtensionUi({
  chatSessionId,
  link,
  children,
}: {
  chatSessionId?: string
  link?: SessionLink
  children: ReactNode
}) {
  const t = useTranslations("externalAgent.extensionUi")
  const agentId = link?.agentId
  const externalSessionId = link?.sessionId
  const identity = link ? `${link.agentId}:${link.sessionId}` : ""
  /**
   * The latest info notice that arrived WHILE this strip was mounted. Set from
   * the event listener rather than derived from `ui.notifications`, so the
   * history a remount hydrates (already seen) never flashes back up.
   */
  const [notice, setNotice] = useState<{ identity: string; id: string; message: string } | null>(
    null
  )
  const [snapshot, setSnapshot] = useState<{ identity: string; ui: ExternalAgentUiState }>(() => ({
    identity: "",
    ui: createExternalAgentUiState(),
  }))
  const ui = snapshot.identity === identity ? snapshot.ui : undefined

  useEffect(() => {
    if (!agentId || !externalSessionId || !chatSessionId) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void import("@/lib/ai/agent/external/manager").then(({ getExternalAgentManager }) => {
      if (disposed) return
      const manager = getExternalAgentManager()
      const session = manager.getSession(agentId, externalSessionId)
      const saved = session?.metadata?.extensionUi as ExternalAgentUiState | undefined
      const restoreQueue = (event: ExternalAgentInputQueueClearedEvent) => {
        const id = `${chatSessionId}:${identity}:queue:${new Date(event.timestamp).toISOString()}`
        const store = useComposerIntentStore.getState()
        if (!store.claimEffect(`${chatSessionId}:${identity}:queue`, id)) return
        const inputs = [...event.queue.steering, ...event.queue.followUp]
        if (!inputs.length) return
        store.stage(chatSessionId, {
          candidateId: id,
          mode: "append",
          prompt: inputs
            .map((input) => input.text)
            .filter(Boolean)
            .join("\n\n"),
          images: inputs.flatMap((input) => input.images ?? []),
          externalSession: { agentId, sessionId: externalSessionId },
        })
      }
      const restored = session?.metadata?.clearedInputQueueEvent as
        ExternalAgentInputQueueClearedEvent | undefined
      if (restored?.sessionId === externalSessionId) restoreQueue(restored)
      setSnapshot({ identity, ui: saved ?? createExternalAgentUiState() })
      unsubscribe = manager.addEventListener(agentId, (event) => {
        if (disposed || event.sessionId !== externalSessionId) return
        if (event.type === "session_info_update" && event.extensionUi) {
          setSnapshot({ identity, ui: event.extensionUi })
          return
        }
        if (event.type === "input_queue_cleared") {
          restoreQueue(event)
          return
        }
        if (event.type !== "extension_ui_update") return
        if (event.update.kind === "notification" && event.update.level === "info") {
          setNotice({ identity, id: event.id, message: event.update.message })
        }
        setSnapshot((current) => ({
          identity,
          ui: reduceExternalAgentUiState(
            current.identity === identity ? current.ui : createExternalAgentUiState(),
            event
          ),
        }))
      })
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [chatSessionId, identity, agentId, externalSessionId])

  useEffect(() => {
    if (!ui || !chatSessionId || !agentId || !externalSessionId) return
    const store = useComposerIntentStore.getState()
    const editor = ui.editor
    if (editor) {
      const id = `${chatSessionId}:${identity}:editor:${editor.id}`
      if (store.claimEffect(`${chatSessionId}:${identity}:editor`, id))
        store.stage(chatSessionId, {
          candidateId: id,
          prompt: editor.text,
          mode: "replace",
          externalSession: { agentId, sessionId: externalSessionId },
        })
    }
    for (const notification of ui.notifications) {
      const id = `${chatSessionId}:${identity}:notification:${notification.id}`
      if (!store.claimEffect(`${chatSessionId}:${identity}:notification`, id)) continue
      // Info is the strip's (see `notice`), never a toast.
      if (notification.level === "info") continue
      const message = stripAnsi(notification.message)
      if (notification.level === "error") {
        toast.error(message, { id })
        continue
      }
      // A warning an extension repeats on every session start (Pi's
      // permission system re-announces an untrusted project each time) is
      // said once per conversation and agent, not once per process.
      if (!store.claimEffect(`${chatSessionId}:${agentId}:warning-text`, message)) continue
      toast.warning(message, { id })
    }
  }, [chatSessionId, identity, agentId, externalSessionId, ui])

  const liveNotice = notice && notice.identity === identity ? notice : null
  useEffect(() => {
    if (!liveNotice) return
    const timer = setTimeout(
      () => setNotice((current) => (current?.id === liveNotice.id ? null : current)),
      EXTENSION_NOTICE_MS
    )
    return () => clearTimeout(timer)
  }, [liveNotice])

  const widgets = Object.entries(ui?.widgets ?? {})
  const statuses = Object.entries(ui?.statuses ?? {}).filter(([, text]) => stripAnsi(text).trim())
  // Text an extension styled for a terminal, drawn with its colours; the
  // block itself wears the app's own chrome so it reads as part of the
  // composer rather than as pasted terminal output.
  const widgetBlock = ([key, widget]: (typeof widgets)[number]) => (
    <pre
      key={key}
      aria-label={t("widget", { name: key })}
      data-testid="extension-widget"
      className="mx-3 mb-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[11px] leading-snug text-muted-foreground"
    >
      <Ansi>{widget.lines.join("\n")}</Ansi>
    </pre>
  )
  return (
    <>
      {ui?.title && (
        <div className="truncate px-3 text-xs text-muted-foreground">{stripAnsi(ui.title)}</div>
      )}
      {widgets.filter(([, widget]) => widget.placement === "aboveEditor").map(widgetBlock)}
      {children}
      {widgets.filter(([, widget]) => widget.placement === "belowEditor").map(widgetBlock)}
      {statuses.length > 0 && (
        // One quiet row of chips, the way a status line reads in a terminal,
        // instead of a full-width line per extension pushing the composer up.
        <div
          role="status"
          aria-label={t("statusRegion")}
          className="flex min-w-0 flex-wrap items-center gap-1 px-3 pb-1"
        >
          {statuses.map(([key, text]) => (
            <span
              key={key}
              title={`${key}: ${stripAnsi(text)}`}
              data-testid="extension-status"
              className="inline-flex min-w-0 max-w-[16rem] items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
            >
              <span className="truncate">
                <Ansi>{text}</Ansi>
              </span>
            </span>
          ))}
        </div>
      )}
      {liveNotice && (
        <div
          aria-live="polite"
          data-testid="extension-notice"
          className="flex min-w-0 items-center gap-1.5 px-3 pb-1 text-[11px] text-muted-foreground"
        >
          <InfoIcon aria-hidden className="size-3 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate" title={stripAnsi(liveNotice.message)}>
            {stripAnsi(liveNotice.message)}
          </span>
          <button
            type="button"
            aria-label={t("dismissNotice")}
            onClick={() => setNotice(null)}
            className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </div>
      )}
    </>
  )
}
