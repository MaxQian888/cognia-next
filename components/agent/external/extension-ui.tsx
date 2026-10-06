"use client"

import { useEffect, useState, type ReactNode } from "react"
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
  const agentId = link?.agentId
  const externalSessionId = link?.sessionId
  const identity = link ? `${link.agentId}:${link.sessionId}` : ""
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
      if (notification.level === "error") toast.error(notification.message, { id })
      else if (notification.level === "warning") toast.warning(notification.message, { id })
      else toast.info(notification.message, { id })
    }
  }, [chatSessionId, identity, agentId, externalSessionId, ui])

  const widgets = Object.entries(ui?.widgets ?? {})
  return (
    <>
      {ui?.title && <div className="truncate px-3 text-xs text-muted-foreground">{ui.title}</div>}
      {widgets
        .filter(([, widget]) => widget.placement === "aboveEditor")
        .map(([key, widget]) => (
          <pre
            key={key}
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 text-xs"
          >
            {widget.lines.join("\n")}
          </pre>
        ))}
      {children}
      {widgets
        .filter(([, widget]) => widget.placement === "belowEditor")
        .map(([key, widget]) => (
          <pre
            key={key}
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 text-xs"
          >
            {widget.lines.join("\n")}
          </pre>
        ))}
      {Object.entries(ui?.statuses ?? {}).map(([key, text]) => (
        <div key={key} role="status" className="truncate px-3 text-xs text-muted-foreground">
          {text}
        </div>
      ))}
    </>
  )
}
