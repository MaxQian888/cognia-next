"use client"

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Loader2Icon,
  MousePointerSquareDashedIcon,
  RotateCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  BrowserAgentIndicator,
  useBrowserAgentActivity,
} from "@/components/browser/browser-agent-indicator"
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewUrl,
} from "@/components/ai-elements/web-preview"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useBrowserLoading } from "@/hooks/browser/use-browser-loading"
import { useBrowserPaneWebview } from "@/hooks/browser/use-browser-pane-webview"
import { useElementSelection } from "@/hooks/browser/use-element-selection"
import { useRegionVisibility } from "@/hooks/browser/use-region-visibility"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { browserClient } from "@/lib/browser/client"
import { setActivePaneRect } from "@/lib/browser/pane-rect"
import { type ElementRect, normalizePreviewUrl } from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"

/** Common local dev-server addresses offered as one-click chips when empty. */
const QUICK_OPEN_URLS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
] as const

/** Host of a URL for display, or the raw string / "" if it can't be parsed. */
function hostOf(url: string | null): string {
  if (!url) return ""
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The v0/Lovable-style preview pane: browser chrome (back / forward / reload +
 * a live-syncing address bar) over a reserved region that the native embedded
 * webview tracks. Picking an element opens a comment box that ships the
 * selection + comment to the chat agent; a camera button ships a plain
 * screenshot the same way.
 */
export function BrowserPreviewPane({ sessionId }: { sessionId?: string }) {
  const t = useTranslations("browser")
  const reservedRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState("")
  const [editingUrl, setEditingUrl] = useState(false)
  const [committedUrl, setCommittedUrl] = useState<string | null>(null)
  const [comment, setComment] = useState("")
  const [sending, setSending] = useState(false)
  const [capturing, setCapturing] = useState(false)

  // The committed url mirrored into a ref so the rect callback (which fires on
  // every scroll/resize frame) can gate pane-rect publishing without being
  // re-created per commit.
  const committedUrlRef = useRef<string | null>(null)

  // Publish the reserved-region rect so the agent's browser_screenshot tool can
  // reuse the verified region-based capture path. Rect updates arrive through
  // this callback instead of state — the pane no longer re-renders per frame.
  const handleRectChange = useCallback((rect: ElementRect) => {
    if (committedUrlRef.current) setActivePaneRect(rect)
  }, [])

  // Load lifecycle + whether the reserved region is genuinely on screen. The
  // native webview floats above React and can't be clipped, so it may only be
  // shown once the page has painted AND the region is visible — otherwise it is
  // parked off-screen so the loading placeholder (or a covering modal) shows and
  // the always-on-top layer stops eating input.
  const { phase, hasPainted, begin: beginLoad } = useBrowserLoading({ url: committedUrl })
  const regionVisible = useRegionVisibility(reservedRef)
  const shouldShowLivePage = !!committedUrl && hasPainted && regionVisible

  const { getRect } = useBrowserPaneWebview(reservedRef, {
    url: committedUrl,
    onRectChange: handleRectChange,
    visible: shouldShowLivePage,
  })
  const { selection, navigated, selectMode, setSelectMode, clearSelection } = useElementSelection({
    driver: browserClient.embedSetSelectMode,
  })
  const { sendComment, sendScreenshot } = useSelectionToChat()
  const { driver, lastAction } = useBrowserAgentActivity()

  useEffect(() => {
    committedUrlRef.current = committedUrl
    setActivePaneRect(committedUrl ? getRect() : null)
  }, [committedUrl, getRect])
  useEffect(() => () => setActivePaneRect(null), [])

  // The in-page info panel (drawn by the injected overlay) can't reach next-intl,
  // so push its localized toggle labels down once the preview webview exists.
  const panelDetailsLabel = t("panel.details")
  const panelCollapseLabel = t("panel.collapse")
  useEffect(() => {
    if (!isTauri() || !committedUrl) return
    void browserClient
      .embedSetPanelLabels({ details: panelDetailsLabel, collapse: panelCollapseLabel })
      .catch(() => {})
  }, [committedUrl, panelDetailsLabel, panelCollapseLabel])

  // The preview's real location (follows in-page navigations and redirects).
  const currentUrl = navigated?.url ?? committedUrl

  // Keep the address bar synced to where the preview actually is — unless the
  // user is mid-edit, in which case their draft wins. Render-time derivation
  // (not an effect) per the React "adjusting state on prop change" pattern.
  const [syncedNavUrl, setSyncedNavUrl] = useState<string | null>(null)
  if (navigated?.url && navigated.url !== syncedNavUrl) {
    setSyncedNavUrl(navigated.url)
    if (!editingUrl) setUrlInput(navigated.url)
  }

  const commitUrl = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const next = normalizePreviewUrl(urlInput)
      if (!next) {
        toast.error(t("errors.navigate"))
        return
      }
      setUrlInput(next)
      beginLoad()
      if (next === committedUrl) {
        // Re-committing the same address still navigates — the page may have
        // moved elsewhere since (in-page navigation, redirect).
        void browserClient.embedNavigate(next).catch(() => {})
      } else {
        setCommittedUrl(next)
      }
      urlInputRef.current?.blur()
    },
    [urlInput, committedUrl, t, beginLoad]
  )

  const onUrlKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setUrlInput(currentUrl ?? "")
        urlInputRef.current?.blur()
      }
    },
    [currentUrl]
  )

  const cancelComment = useCallback(() => {
    clearSelection()
    setComment("")
    void browserClient.embedClearSelection().catch(() => {})
  }, [clearSelection])

  const onSend = useCallback(async () => {
    if (!selection || !comment.trim()) return
    setSending(true)
    try {
      const ok = await sendComment(selection, comment, {
        sessionId,
        captureRect: getRect() ?? undefined,
      })
      if (ok) {
        toast.success(t("comment.sent"))
        setComment("")
        clearSelection()
        void browserClient.embedClearSelection().catch(() => {})
      } else {
        toast.error(t("comment.noSession"))
      }
    } catch {
      toast.error(t("comment.failed"))
    } finally {
      setSending(false)
    }
  }, [selection, comment, sessionId, getRect, sendComment, clearSelection, t])

  const onCommentKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault()
        cancelComment()
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void onSend()
      }
    },
    [cancelComment, onSend]
  )

  const onScreenshot = useCallback(async () => {
    const rect = getRect()
    if (!rect) return
    setCapturing(true)
    try {
      const ok = await sendScreenshot(rect, { sessionId, pageUrl: currentUrl ?? undefined })
      if (ok) toast.success(t("screenshot.sent"))
      else toast.error(t("comment.noSession"))
    } catch {
      toast.error(t("screenshot.failed"))
    } finally {
      setCapturing(false)
    }
  }, [getRect, sendScreenshot, sessionId, currentUrl, t])

  const openQuickUrl = useCallback((url: string) => {
    setUrlInput(url)
    setCommittedUrl(url)
  }, [])

  // Outside Tauri (web / Capacitor) there is no native webview to track a
  // reserved region, so element-selection is unavailable. Fall back to the
  // ai-elements WebPreview: a sandboxed iframe with a URL bar so web users can
  // still preview a local dev server (its primary use). Cross-origin sites that
  // forbid framing won't load, which is expected for a best-effort web preview.
  if (!isTauri()) {
    return (
      <WebPreview className="h-full rounded-none border-0" data-testid="browser-web-preview">
        <WebPreviewNavigation>
          <WebPreviewUrl placeholder={t("url.placeholder")} aria-label={t("url.placeholder")} />
        </WebPreviewNavigation>
        <WebPreviewBody className="bg-background" title={t("empty.title")} />
      </WebPreview>
    )
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="relative flex items-center gap-1.5 border-b px-2 py-1.5">
        {phase === "loading" && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
            role="progressbar"
            aria-label={t("loading.label")}
            data-testid="browser-progress"
          >
            <div className="browser-progress-bar h-full w-1/3 rounded-full bg-primary" />
          </div>
        )}
        <div className="flex items-center">
          <TooltipIconButton
            tooltip={t("actions.back")}
            aria-label={t("actions.back")}
            disabled={!committedUrl}
            onClick={() => {
              beginLoad()
              void browserClient.embedBack()
            }}
          >
            <ArrowLeftIcon />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={t("actions.forward")}
            aria-label={t("actions.forward")}
            disabled={!committedUrl}
            onClick={() => {
              beginLoad()
              void browserClient.embedForward()
            }}
          >
            <ArrowRightIcon />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={t("actions.reload")}
            aria-label={t("actions.reload")}
            disabled={!committedUrl}
            onClick={() => {
              beginLoad()
              void browserClient.embedReload()
            }}
          >
            <RotateCwIcon />
          </TooltipIconButton>
        </div>
        <form onSubmit={commitUrl} className="min-w-0 flex-1">
          <div className="relative">
            <GlobeIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={urlInputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onFocus={(e) => {
                setEditingUrl(true)
                e.target.select()
              }}
              onBlur={() => setEditingUrl(false)}
              onKeyDown={onUrlKeyDown}
              placeholder={t("url.placeholder")}
              aria-label={t("url.placeholder")}
              className="h-8 rounded-full border-transparent bg-muted/60 pl-8 text-sm shadow-none focus-visible:border-input focus-visible:bg-background"
            />
          </div>
        </form>
        <div className="flex items-center">
          <TooltipIconButton
            tooltip={t("actions.screenshot")}
            aria-label={t("actions.screenshot")}
            disabled={!committedUrl || capturing}
            onClick={() => void onScreenshot()}
          >
            <CameraIcon />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={t("actions.openExternal")}
            aria-label={t("actions.openExternal")}
            disabled={!currentUrl}
            onClick={() => {
              if (currentUrl) void openExternal(currentUrl)
            }}
          >
            <ExternalLinkIcon />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={selectMode ? t("actions.cancelSelect") : t("actions.selectElement")}
            aria-label={selectMode ? t("actions.cancelSelect") : t("actions.selectElement")}
            disabled={!committedUrl}
            className={cn(selectMode && "bg-primary/15 text-primary")}
            onClick={() => void setSelectMode(!selectMode)}
          >
            <MousePointerSquareDashedIcon />
          </TooltipIconButton>
        </div>
        <BrowserAgentIndicator driver={driver} lastAction={lastAction} />
      </div>

      <div ref={reservedRef} className="relative min-h-0 flex-1">
        {committedUrl && !hasPainted && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background p-6 text-center"
            role="status"
            aria-live="polite"
            data-testid="browser-loading"
          >
            <div className="flex flex-col items-center gap-3">
              <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t("loading.title", { host: hostOf(currentUrl) })}
              </p>
            </div>
            <div className="w-full max-w-sm space-y-2.5" aria-hidden>
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        )}
        {!committedUrl && (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
              <GlobeIcon className="size-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("empty.title")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">{t("empty.hint")}</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-muted-foreground">{t("empty.quickOpen")}</span>
              {QUICK_OPEN_URLS.map((url) => (
                <Button
                  key={url}
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-3 font-mono text-xs font-normal"
                  onClick={() => openQuickUrl(url)}
                >
                  {new URL(url).host}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      {selection && (
        <div className="border-t bg-background p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                {selection.tagName.toLowerCase()}
              </Badge>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {selection.componentName ? `<${selection.componentName}>` : selection.selector}
              </p>
            </div>
            <TooltipIconButton
              tooltip={t("comment.cancel")}
              aria-label={t("comment.cancel")}
              size="icon-xs"
              onClick={cancelComment}
            >
              <XIcon />
            </TooltipIconButton>
          </div>
          <Textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={onCommentKeyDown}
            placeholder={t("comment.placeholder")}
            aria-label={t("comment.title")}
            rows={2}
            className="resize-none text-sm"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{t("comment.hint")}</span>
            <Button size="sm" disabled={sending || !comment.trim()} onClick={() => void onSend()}>
              <SendIcon className="size-3.5" />
              {t("comment.send")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
