"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import type { GooseChildSession, GooseSessionControls } from "@cognia/agent-acp/goose-session"
import { useExternalSessionLinkForSession } from "@/stores/agent/agent-runtime-store"
import type { ExternalSessionLink } from "@/stores/agent/agent-runtime-store"
import type { ExternalAgentToolMetadata } from "@cognia/agent-contracts/external-agent"

/** The delegate result's navigation action uses the recorded owning chat session. */
export function GooseChildSessionLink({
  child,
  chatSessionId,
}: {
  child: NonNullable<ExternalAgentToolMetadata["nativeSubagent"]>
  chatSessionId?: string
}) {
  const link = useExternalSessionLinkForSession(chatSessionId)
  if (!link || !chatSessionId) return null
  const owner = JSON.stringify([link.agentId, link.sessionId, child.sessionId, link.host ?? null])
  return (
    <GooseChildSessionView key={owner} child={child} chatSessionId={chatSessionId} link={link} />
  )
}

function GooseChildSessionView({
  child,
  chatSessionId,
  link,
}: {
  child: NonNullable<ExternalAgentToolMetadata["nativeSubagent"]>
  chatSessionId: string
  link: ExternalSessionLink
}) {
  const t = useTranslations("externalAgent.goose")
  const [snapshot, setSnapshot] = useState<{ owner: string; value: GooseChildSession }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const owner = `${link.agentId}:${link.sessionId}:${child.sessionId}`
  const visible = snapshot?.owner === owner ? snapshot.value : undefined
  async function inspect() {
    if (!link || pending) return
    setPending(true)
    setError(false)
    try {
      const manager = link.host
        ? (
            await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
          ).createRemoteSessionOperationsClient({
            stamp: link.host,
            chatSessionId: chatSessionId!,
            externalSessionId: link.sessionId,
          })
        : (await import("@/lib/ai/agent/external/manager")).getExternalAgentManager()
      const value = await manager.inspectGooseChild(link.agentId, link.sessionId, child.sessionId)
      if (alive.current) setSnapshot({ owner, value })
    } catch {
      if (alive.current) setError(true)
    } finally {
      if (alive.current) setPending(false)
    }
  }
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void inspect()}>
        {visible ? t("reloadProgress") : t("viewChild", { id: child.sessionId })}
      </Button>
      {visible && (
        <pre
          aria-label={t("transcript")}
          className="max-h-80 overflow-auto whitespace-pre-wrap text-xs"
        >
          {visible.transcript}
        </pre>
      )}
      {error && <p role="alert">{t("operationFailed")}</p>}
    </div>
  )
}

/** A passive export view; recovery is submitted to the parent's ordinary chat path. */
export function GooseSessionInspector({
  api,
  parentId,
  busy,
  onPrompt,
}: {
  api: GooseSessionControls
  parentId: string
  busy: boolean
  onPrompt?: (prompt: string) => Promise<unknown>
}) {
  const t = useTranslations("externalAgent.goose")
  const [children, setChildren] = useState<string[]>([])
  const [child, setChild] = useState<GooseChildSession>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const alive = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(false)
    try {
      await work()
    } catch {
      if (alive.current) setError(true)
    } finally {
      inFlight.current = false
      if (alive.current) setPending(false)
    }
  }
  return (
    <section aria-label={t("childrenTitle")} className="space-y-2 rounded-md border p-3">
      <h4 className="font-medium">{t("childrenTitle")}</h4>
      <p className="text-xs text-muted-foreground">{t("readOnlyHint")}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          void run(async () => {
            const ids = await api.listChildren(parentId)
            if (alive.current) setChildren(ids)
          })
        }
      >
        {t("refreshChildren")}
      </Button>
      {children.map((id) => (
        <Button
          key={id}
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const snapshot = await api.inspect(parentId, id)
              if (alive.current) setChild(snapshot)
            })
          }
        >
          {t("viewChild", { id })}
        </Button>
      ))}
      {child && (
        <div className="space-y-2">
          <h5 className="break-all text-sm">{child.title}</h5>
          <pre
            aria-label={t("transcript")}
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs"
          >
            {child.transcript}
          </pre>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const snapshot = await api.inspect(parentId, child.id)
                if (alive.current) setChild(snapshot)
              })
            }
          >
            {t("reloadProgress")}
          </Button>
          {onPrompt && (
            <Button
              size="sm"
              disabled={pending || busy || child.completed}
              onClick={() =>
                void run(async () => {
                  const prompt = await api.recoveryPrompt(parentId, child.id)
                  if (!alive.current) return
                  await onPrompt(prompt)
                })
              }
            >
              {t("resumeChild")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t("operationFailed")}
        </p>
      )}
    </section>
  )
}
