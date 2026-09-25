"use client"

/**
 * The desktop chat copilot's overlay panel (ADR-0194 §8). Runs in the
 * frameless, non-activating `chat-copilot` window beside the chat app: the
 * pipeline lives in the main window (`lib/reply-copilot/screen/controller.ts`)
 * and pushes views here; this panel only renders them and sends intents back.
 *
 * It also asks for the capture's consent, because the main window is usually
 * behind the chat app and its prompt would go unseen. Output is copy only:
 * nothing here can type into the other app.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon, SparklesIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { CopilotResultCard } from "@/components/reply-copilot/copilot-result-card"
import {
  CONSENT_GRANT_DURATIONS_MS,
  grantDurationMinutes,
} from "@/lib/automation/consent-durations"
import {
  copyFromChatCopilotOverlay,
  onChatCopilotView,
  resizeChatCopilotOverlay,
  revealChatCopilotOverlay,
  sendChatCopilotIntent,
  type ChatCopilotIntent,
  type ChatCopilotView,
  type OverlayConsent,
  type ScreenReadSummary,
} from "@/lib/reply-copilot/screen/overlay-client"

/** Panel width in logical px; the height follows the content. */
export const CHAT_COPILOT_PANEL_WIDTH = 380

function send(intent: ChatCopilotIntent) {
  void sendChatCopilotIntent(intent)
}

function Busy({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
      <Spinner className="size-4" />
      {label}
    </div>
  )
}

function ConsentPrompt({ consent, appName }: { consent: OverlayConsent; appName: string | null }) {
  const t = useTranslations("chatCopilot.consent")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.ceil((consent.expiresAt - now) / 1000))
  const app = consent.processName ?? appName ?? t("unknownApp")
  const answer = (allow: boolean, grantDurationMs?: number) =>
    send({
      kind: "consent",
      id: consent.id,
      allow,
      ...(grantDurationMs !== undefined ? { grantDurationMs } : {}),
    })

  return (
    <div className="space-y-3" data-testid="chat-copilot-consent">
      <div className="flex items-start gap-2 text-sm">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
        <p>{t("question", { app })}</p>
      </div>
      {consent.windowTitle ? (
        <p className="truncate text-xs text-muted-foreground">
          {t("window", { title: consent.windowTitle })}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("autoReject", { seconds })}</p>
      <div className="flex flex-col gap-2">
        <Button size="sm" onClick={() => answer(true)}>
          {t("allowOnce")}
        </Button>
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{t("allowForLabel", { app })}</span>
          <div className="flex gap-1">
            {CONSENT_GRANT_DURATIONS_MS.map((ms) => (
              <Button
                key={ms}
                size="sm"
                variant="outline"
                className="flex-1 text-[11px]"
                onClick={() => answer(true, ms)}
              >
                {t("allowForMinutes", { minutes: grantDurationMinutes(ms) })}
              </Button>
            ))}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => answer(false)}>
          {t("reject")}
        </Button>
      </div>
    </div>
  )
}

function ReadSummary({ read }: { read: ScreenReadSummary }) {
  const t = useTranslations("chatCopilot.read")
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="chat-copilot-read">
      <p>{t("messages", { count: read.bubbleCount, app: read.appName })}</p>
      {read.unsidedReason ? <p>{t(`unsided.${read.unsidedReason}`)}</p> : null}
      {read.contact.kind === "match" ? (
        <p>{t("contactMatched", { name: read.contact.name })}</p>
      ) : read.contact.kind === "ambiguous" ? (
        <p>{t("contactAmbiguous", { name: read.contact.name })}</p>
      ) : null}
    </div>
  )
}

function Instructions({
  initial,
  onSubmit,
}: {
  initial: string
  onSubmit: (instructions: string) => void
}) {
  const t = useTranslations("chatCopilot.actions")
  const [value, setValue] = useState(initial)
  return (
    <div className="space-y-2">
      <Textarea
        aria-label={t("instructions")}
        placeholder={t("instructions")}
        value={value}
        rows={2}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button size="sm" variant="outline" className="w-full" onClick={() => onSubmit(value)}>
        {t("redraft")}
      </Button>
    </div>
  )
}

function Body({ view }: { view: ChatCopilotView | null }) {
  const t = useTranslations("chatCopilot")
  if (!view || view.phase === "capturing") return <Busy label={t("phase.capturing")} />
  switch (view.phase) {
    case "consent":
      return <ConsentPrompt consent={view.consent} appName={null} />
    case "reading":
      return <Busy label={t("phase.reading")} />
    case "thinking":
      return (
        <div className="space-y-2">
          <ReadSummary read={view.read} />
          <Busy label={t("phase.thinking")} />
        </div>
      )
    case "done":
      return (
        <div className="space-y-3">
          <ReadSummary read={view.read} />
          <CopilotResultCard
            result={view.result}
            knowledge={view.knowledge}
            writeText={copyFromChatCopilotOverlay}
          />
          <Instructions
            key={view.runId}
            initial={view.instructions}
            onSubmit={(instructions) => send({ kind: "redraft", instructions })}
          />
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            onClick={() => send({ kind: "retry" })}
          >
            {t("actions.recapture")}
          </Button>
        </div>
      )
    case "error":
      return (
        <div className="space-y-3" data-testid="chat-copilot-error">
          {view.read ? <ReadSummary read={view.read} /> : null}
          <p className="text-sm">{t(`errors.${view.error}`)}</p>
          {view.error === "screen_recording_required" ? (
            <Button
              size="sm"
              className="w-full"
              onClick={() => send({ kind: "openScreenRecordingSettings" })}
            >
              {t("actions.openScreenRecording")}
            </Button>
          ) : null}
          {view.error === "draft_failed" ? (
            <Button
              size="sm"
              className="w-full"
              onClick={() => send({ kind: "redraft", instructions: view.instructions ?? "" })}
            >
              {t("actions.redraft")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => send({ kind: "retry" })}
            >
              {t("actions.recapture")}
            </Button>
          )}
        </div>
      )
  }
}

export function ChatCopilotOverlay() {
  const t = useTranslations("chatCopilot")
  const [view, setView] = useState<ChatCopilotView | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Transparent page, the same seam the pet overlay and the dock use.
  useEffect(() => {
    document.documentElement.setAttribute("data-pet-overlay", "true")
    return () => document.documentElement.removeAttribute("data-pet-overlay")
  }, [])

  // Subscribe, then ask for the current view: the panel may mount after the
  // main window already published it.
  useEffect(() => {
    let disposed = false
    let off: (() => void) | null = null
    void onChatCopilotView((next) => {
      if (!disposed) setView(next)
    }).then((unsubscribe) => {
      if (disposed) unsubscribe()
      else off = unsubscribe
      send({ kind: "ready" })
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [])

  useEffect(() => {
    void revealChatCopilotOverlay()
  }, [])

  useEffect(() => {
    const node = panelRef.current
    if (!node) return
    const push = () => {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        void resizeChatCopilotOverlay(Math.ceil(rect.width), Math.ceil(rect.height))
      }
    }
    push()
    const observer = new ResizeObserver(push)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") send({ kind: "close" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const subtitle =
    view && "read" in view && view.read
      ? [view.read.appName, view.read.contact.kind === "match" ? view.read.contact.name : null]
          .filter(Boolean)
          .join(" · ")
      : null

  return (
    <div
      ref={panelRef}
      style={{ width: CHAT_COPILOT_PANEL_WIDTH }}
      className="max-h-[80vh] overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
      aria-label={t("title")}
      role="dialog"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("title")}</p>
            {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("actions.close")}
          onClick={() => send({ kind: "close" })}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <Body view={view} />
      <p className="mt-3 text-[11px] text-muted-foreground">{t("footer")}</p>
    </div>
  )
}
