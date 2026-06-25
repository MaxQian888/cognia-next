"use client"

import { MousePointerSquareDashedIcon, RotateCwIcon, SendIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  BrowserAgentIndicator,
  useBrowserAgentActivity,
} from "@/components/browser/browser-agent-indicator"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useBrowserPaneWebview } from "@/hooks/browser/use-browser-pane-webview"
import { useElementSelection } from "@/hooks/browser/use-element-selection"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { browserClient } from "@/lib/browser/client"
import { setActivePaneRect } from "@/lib/browser/pane-rect"
import { normalizePreviewUrl } from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"

/**
 * The v0/Lovable-style preview pane: a URL bar + select-mode toggle over a
 * reserved region that the native embedded webview tracks. Picking an element
 * opens a comment box that ships the selection + comment to the chat agent.
 */
export function BrowserPreviewPane({ sessionId }: { sessionId?: string }) {
  const t = useTranslations("browser")
  const reservedRef = useRef<HTMLDivElement>(null)
  const [urlInput, setUrlInput] = useState("")
  const [committedUrl, setCommittedUrl] = useState<string | null>(null)
  const [comment, setComment] = useState("")
  const [sending, setSending] = useState(false)

  const { rect } = useBrowserPaneWebview(reservedRef, { url: committedUrl })
  const { selection, selectMode, setSelectMode, clearSelection } = useElementSelection({
    driver: browserClient.embedSetSelectMode,
  })
  const { sendComment } = useSelectionToChat()
  const { driver, lastAction } = useBrowserAgentActivity()

  // Publish the reserved-region rect so the agent's browser_screenshot tool can
  // reuse the verified region-based capture path. Cleared on unmount.
  useEffect(() => {
    setActivePaneRect(committedUrl ? (rect ?? null) : null)
    return () => setActivePaneRect(null)
  }, [rect, committedUrl])

  const commitUrl = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const next = normalizePreviewUrl(urlInput)
      if (!next) {
        toast.error(t("errors.navigate"))
        return
      }
      setCommittedUrl(next)
    },
    [urlInput, t]
  )

  const onSend = useCallback(async () => {
    if (!selection) return
    setSending(true)
    try {
      const ok = await sendComment(selection, comment, {
        sessionId,
        captureRect: rect ?? undefined,
      })
      if (ok) {
        toast.success(t("comment.sent"))
        setComment("")
        clearSelection()
      } else {
        toast.error(t("comment.noSession"))
      }
    } catch {
      toast.error(t("comment.failed"))
    } finally {
      setSending(false)
    }
  }, [selection, comment, sessionId, rect, sendComment, clearSelection, t])

  if (!isTauri()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t("empty.hint")}
      </div>
    )
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <TooltipIconButton
          tooltip={t("actions.reload")}
          aria-label={t("actions.reload")}
          disabled={!committedUrl}
          onClick={() => browserClient.embedReload()}
        >
          <RotateCwIcon />
        </TooltipIconButton>
        <form onSubmit={commitUrl} className="flex flex-1 items-center gap-1">
          <Input
            type="text"
            inputMode="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={t("url.placeholder")}
            aria-label={t("url.placeholder")}
            className="h-8"
          />
          <Button type="submit" size="sm" variant="secondary">
            {t("url.go")}
          </Button>
        </form>
        <TooltipIconButton
          tooltip={selectMode ? t("actions.cancelSelect") : t("actions.selectElement")}
          aria-label={selectMode ? t("actions.cancelSelect") : t("actions.selectElement")}
          disabled={!committedUrl}
          className={cn(selectMode && "bg-primary/15 text-primary")}
          onClick={() => void setSelectMode(!selectMode)}
        >
          <MousePointerSquareDashedIcon />
        </TooltipIconButton>
        <BrowserAgentIndicator driver={driver} lastAction={lastAction} />
      </div>

      <div ref={reservedRef} className="relative min-h-0 flex-1">
        {!committedUrl && (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-sm font-medium">{t("empty.title")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t("empty.hint")}</p>
          </div>
        )}
      </div>

      {selection && (
        <div className="border-t bg-background p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t("selection.selector")}:</span>{" "}
              {selection.selector}
            </p>
            <TooltipIconButton
              tooltip={t("comment.cancel")}
              aria-label={t("comment.cancel")}
              size="icon-xs"
              onClick={() => {
                clearSelection()
                setComment("")
              }}
            >
              <XIcon />
            </TooltipIconButton>
          </div>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("comment.placeholder")}
            aria-label={t("comment.title")}
            rows={2}
            className="resize-none text-sm"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={sending || !comment.trim()} onClick={onSend}>
              <SendIcon className="size-3.5" />
              {t("comment.send")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
