"use client"

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  CheckIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Loader2Icon,
  LockIcon,
  MoreHorizontalIcon,
  MousePointerSquareDashedIcon,
  RotateCwIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useLiveQuery } from "dexie-react-hooks"

import {
  BrowserAgentIndicator,
  useBrowserAgentActivity,
} from "@/components/browser/browser-agent-indicator"
import { BrowserCookieImportAction } from "@/components/browser/browser-cookie-import-action"
import { BrowserFindBarSection, isFindShortcut } from "@/components/browser/browser-find-bar"
import { BrowserHistoryMenu } from "@/components/browser/browser-history-menu"
import { BrowserRecorderPanel } from "@/components/browser/browser-recorder-panel"
import { BrowserZoomControl, MAX_ZOOM, MIN_ZOOM } from "@/components/browser/browser-zoom-control"
import { RemoteBrowserPreview } from "@/components/browser/remote-browser-preview"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useElementWidth } from "@/hooks/use-element-width"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useBrowserLoading } from "@/hooks/browser/use-browser-loading"
import { useBrowserPaneWebview } from "@/hooks/browser/use-browser-pane-webview"
import { useElementSelection } from "@/hooks/browser/use-element-selection"
import { useRegionVisibility } from "@/hooks/browser/use-region-visibility"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { browserClient } from "@/lib/browser/client"
import {
  deleteExpiredBrowserAnnotations,
  listActionableBrowserAnnotations,
  transitionBrowserAnnotation,
  type BrowserAnnotationIntent,
  type BrowserAnnotationSeverity,
} from "@/lib/db/browser-annotations"
import { setActivePaneRect } from "@/lib/browser/pane-rect"
import {
  type ElementRect,
  type OutputDetailLevel,
  normalizePreviewUrl,
} from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Common local dev-server addresses offered as one-click chips when empty. */
const QUICK_OPEN_URLS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
] as const
const DETAIL_LEVEL_STORAGE_KEY = "cognia.browser.output-detail"
const ZOOM_STORAGE_KEY = "cognia.browser.zoom"
const DETAIL_LEVELS: OutputDetailLevel[] = ["compact", "standard", "detailed", "forensic"]

/**
 * Measured toolbar widths at which the secondary controls stop being inline and
 * pack into the "⋯" popover instead. The pane is docked in the chat right rail
 * as often as it fills the `/browser` page, and that rail's floor is 24% of the
 * window (~300px on a laptop) — well under the ~620px the full control row
 * needs. Wrapping instead of packing cost four toolbar rows and pushed the
 * address bar onto a line of its own.
 */
const COMPACT_TOOLBAR_PX = 460
const WIDE_TOOLBAR_PX = 680

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
 * The address bar's read-mode form: scheme (carried by the lock / globe icon),
 * a leading `www.` and a bare trailing slash are dropped, so what survives
 * end-truncation in a narrow rail is the host — not `https://www.exam…`. The
 * host and the rest are returned separately so the path can be dimmed.
 *
 * Returns `null` for anything that isn't a parseable http(s) address; a
 * half-typed draft is always shown verbatim.
 */
export function addressDisplayParts(
  url: string
): { host: string; rest: string; secure: boolean } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return {
    host: parsed.host.replace(/^www\./, ""),
    rest: rest === "/" ? "" : rest,
    secure: parsed.protocol === "https:",
  }
}

/**
 * The v0/Lovable-style preview pane: browser chrome (back / forward / reload +
 * a live-syncing address bar) over a reserved region that the native embedded
 * webview tracks. Picking an element opens a comment box that ships the
 * selection + comment to the chat agent; a camera button ships a plain
 * screenshot the same way.
 */
export function BrowserPreviewPane({
  sessionId,
  parentChatSessionId,
  workspaceId,
  profileId,
  initialUrl,
  ownerId,
}: {
  sessionId?: string
  parentChatSessionId?: string
  workspaceId?: string
  profileId?: string
  initialUrl?: string
  ownerId?: string
}) {
  const t = useTranslations("browser")
  const normalizedInitialUrl = initialUrl ? normalizePreviewUrl(initialUrl) : null
  const reservedRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState(normalizedInitialUrl ?? "")
  const [editingUrl, setEditingUrl] = useState(false)
  const [committedUrl, setCommittedUrl] = useState<string | null>(normalizedInitialUrl)
  const [comment, setComment] = useState("")
  const [sending, setSending] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [annotationIntent, setAnnotationIntent] = useState<BrowserAnnotationIntent>("change")
  const [annotationSeverity, setAnnotationSeverity] =
    useState<BrowserAnnotationSeverity>("suggestion")
  const [detailLevel, setDetailLevel] = useState<OutputDetailLevel>(() => {
    if (typeof window === "undefined") return "standard"
    const stored = window.localStorage.getItem(DETAIL_LEVEL_STORAGE_KEY)
    return DETAIL_LEVELS.includes(stored as OutputDetailLevel)
      ? (stored as OutputDetailLevel)
      : "standard"
  })
  const [zoom, setZoom] = useState<number>(() => {
    if (typeof window === "undefined") return 1
    const stored = Number(window.localStorage.getItem(ZOOM_STORAGE_KEY))
    return Number.isFinite(stored) && stored >= MIN_ZOOM && stored <= MAX_ZOOM ? stored : 1
  })
  const [findOpen, setFindOpen] = useState(false)
  const { recent: recentHistory, push: pushHistory, clear: clearHistory } = useBrowserHistory()
  const annotationQueue =
    useLiveQuery(
      () => (sessionId ? listActionableBrowserAnnotations(sessionId) : Promise.resolve([])),
      [sessionId],
      []
    ) ?? []
  const pendingAnnotations = annotationQueue.filter((annotation) => annotation.status === "pending")

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
    ownerId,
    onRectChange: handleRectChange,
    visible: shouldShowLivePage,
  })
  const { selection, selections, navigated, selectMode, setSelectMode, clearSelection } =
    useElementSelection({ driver: browserClient.embedSetSelectMode })
  const { sendComment, queueAnnotation, sendAnnotations, sendScreenshot, sendText } =
    useSelectionToChat()
  const { driver, lastAction } = useBrowserAgentActivity()
  const toolbarWidth = useElementWidth(toolbarRef)
  const remoteBrowserEnabled = useSettingsStore(
    (state) => state.settings?.remoteBrowserEnabled ?? false
  )
  const activeChatSessionId = useChatStore((state) => state.activeSessionId)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)

  useEffect(() => {
    committedUrlRef.current = committedUrl
    setActivePaneRect(committedUrl ? getRect() : null)
  }, [committedUrl, getRect])
  useEffect(() => () => setActivePaneRect(null), [])
  useEffect(() => {
    window.localStorage.setItem(DETAIL_LEVEL_STORAGE_KEY, detailLevel)
  }, [detailLevel])
  useEffect(() => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom))
  }, [zoom])
  // Re-apply zoom whenever the page becomes live (covers webview recreation)
  // or the user changes it. Native zoom persists across in-page navigations.
  useEffect(() => {
    if (shouldShowLivePage) void browserClient.embedSetZoom(zoom).catch(() => {})
  }, [shouldShowLivePage, zoom])
  useEffect(() => {
    void deleteExpiredBrowserAnnotations(new Date().getTime())
  }, [])

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

  // How the toolbar packs itself. Width 0 means "not measured yet" (SSR, first
  // paint, jsdom) — take the widest branch, matching the `/browser` page. Each
  // tier renders the identical control roster, only in a different container,
  // so nothing mounts twice and no action becomes unreachable.
  const tier: "compact" | "medium" | "wide" =
    toolbarWidth === 0 || toolbarWidth >= WIDE_TOOLBAR_PX
      ? "wide"
      : toolbarWidth >= COMPACT_TOOLBAR_PX
        ? "medium"
        : "compact"

  // Record each visited location for the address-bar history menu.
  useEffect(() => {
    if (currentUrl) pushHistory(currentUrl)
  }, [currentUrl, pushHistory])

  // Keep the address bar synced to where the preview actually is — unless the
  // user is mid-edit, in which case their draft wins. Render-time derivation
  // (not an effect) per the React "adjusting state on prop change" pattern.
  const [syncedNavUrl, setSyncedNavUrl] = useState<string | null>(null)
  if (navigated?.url && navigated.url !== syncedNavUrl) {
    setSyncedNavUrl(navigated.url)
    if (!editingUrl) setUrlInput(navigated.url)
  }

  // The inspection rail (selection + annotation queue) slides in beside the
  // reserved region. Keep it mounted through its slide-out so the exit
  // animation can play, then unmount on animationEnd. Set-state-during-render
  // (not an effect) — same "adjust state on prop change" pattern as syncedNavUrl.
  const railWanted = !!selection || annotationQueue.length > 0
  const [railRendered, setRailRendered] = useState(railWanted)
  if (railWanted && !railRendered) setRailRendered(true)

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

  const onQueue = useCallback(async () => {
    if (!selection || !comment.trim()) return
    setSending(true)
    try {
      const baseUrl = new URL(currentUrl ?? selection.pageUrl).origin
      const targets = selections.length > 0 ? selections : [selection]
      const annotations = await Promise.all(
        targets.map((target) =>
          queueAnnotation(target, comment, {
            sessionId,
            baseUrl,
            intent: annotationIntent,
            severity: annotationSeverity,
          })
        )
      )
      const saved = annotations.filter((item) => item != null)
      if (saved.length > 0) {
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
  }, [
    selection,
    selections,
    comment,
    currentUrl,
    sessionId,
    queueAnnotation,
    clearSelection,
    t,
    annotationIntent,
    annotationSeverity,
  ])

  const onSend = useCallback(async () => {
    if (!selection || !comment.trim()) return
    setSending(true)
    try {
      const ok = await sendComment(selections.length > 0 ? selections : selection, comment, {
        sessionId,
        captureRect: getRect() ?? undefined,
        detailLevel,
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
  }, [
    selection,
    selections,
    comment,
    sessionId,
    getRect,
    sendComment,
    clearSelection,
    t,
    detailLevel,
  ])

  const onSendQueue = useCallback(async () => {
    setSending(true)
    try {
      const ok = await sendAnnotations(pendingAnnotations, {
        sessionId,
        captureRect: getRect() ?? undefined,
        detailLevel,
      })
      if (ok) {
        toast.success(t("annotation.sent", { count: pendingAnnotations.length }))
      } else {
        toast.error(t("comment.noSession"))
      }
    } catch {
      toast.error(t("comment.failed"))
    } finally {
      setSending(false)
    }
  }, [pendingAnnotations, sessionId, getRect, sendAnnotations, t, detailLevel])

  const transitionQueuedAnnotation = useCallback(
    async (id: string, status: "resolved" | "dismissed") => {
      try {
        await transitionBrowserAnnotation(id, status, new Date().getTime(), "human")
      } catch {
        toast.error(t("comment.failed"))
      }
    },
    [t]
  )

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

  const reloadAfterCookieImport = useCallback(async () => {
    beginLoad()
    await browserClient.embedReload()
  }, [beginLoad])

  const runFind = useCallback(
    (query: string, options: { forward: boolean }) => browserClient.embedFind(query, options),
    []
  )
  const closeFind = useCallback(() => {
    setFindOpen(false)
    void browserClient.embedFindClear().catch(() => {})
  }, [])
  const navigateHistory = useCallback(
    (url: string) => {
      setUrlInput(url)
      beginLoad()
      setCommittedUrl(url)
    },
    [beginLoad]
  )

  // Outside Tauri (web / Capacitor) there is no native webview to track a
  // reserved region, so element-selection is unavailable. Fall back to the
  // ai-elements WebPreview: a sandboxed iframe with a URL bar so web users can
  // still preview a local dev server (its primary use). Cross-origin sites that
  // forbid framing won't load, which is expected for a best-effort web preview.
  if (!isTauri()) {
    if (remoteBrowserEnabled) {
      return (
        <RemoteBrowserPreview
          chatSessionId={sessionId ?? activeChatSessionId ?? "browser-preview"}
          parentChatSessionId={parentChatSessionId}
          workspaceId={workspaceId ?? activeProjectId ?? "default"}
          profileId={profileId}
          initialUrl={normalizedInitialUrl ?? undefined}
        />
      )
    }
    return (
      <WebPreview className="h-full rounded-none border-0" data-testid="browser-web-preview">
        <WebPreviewNavigation>
          <WebPreviewUrl placeholder={t("url.placeholder")} aria-label={t("url.placeholder")} />
        </WebPreviewNavigation>
        <WebPreviewBody className="bg-background" title={t("empty.title")} />
      </WebPreview>
    )
  }

  // Read-mode address: only while the field still mirrors the live location.
  // An uncommitted draft is never rewritten under the user's cursor.
  const addressDisplay =
    editingUrl || urlInput !== (currentUrl ?? "") ? null : addressDisplayParts(urlInput)
  const SchemeIcon = addressDisplay?.secure ? LockIcon : GlobeIcon

  // Page-inspection actions: the ones a reviewer reaches for on every pass.
  // First to stay inline, last to collapse.
  const inspectActions = (
    <>
      <BrowserHistoryMenu
        recent={recentHistory}
        onNavigate={navigateHistory}
        onClear={clearHistory}
        disabled={recentHistory.length === 0}
      />
      <TooltipIconButton
        tooltip={t("actions.screenshot")}
        aria-label={t("actions.screenshot")}
        disabled={!committedUrl || capturing}
        onClick={() => void onScreenshot()}
      >
        <CameraIcon />
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
      <TooltipIconButton
        tooltip={t("actions.find")}
        aria-label={t("actions.find")}
        disabled={!committedUrl}
        className={cn(findOpen && "bg-primary/15 text-primary")}
        onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
      >
        <SearchIcon />
      </TooltipIconButton>
    </>
  )

  // Page-setup actions: set once and left alone, so they collapse first.
  const pageActions = (
    <>
      <BrowserZoomControl zoom={zoom} onZoomChange={setZoom} disabled={!committedUrl} />
      <BrowserCookieImportAction currentUrl={currentUrl} onReload={reloadAfterCookieImport} />
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
    </>
  )

  // Annotation detail is an output setting for the comment/screenshot payload,
  // not navigation chrome — it lives in the popover at every width rather than
  // spending 96px of the narrowest row.
  const detailControl = (
    <select
      value={detailLevel}
      onChange={(event) => setDetailLevel(event.target.value as OutputDetailLevel)}
      aria-label={t("detail.label")}
      className="h-7 w-full rounded-md border bg-background px-1 text-xs"
    >
      {DETAIL_LEVELS.map((level) => (
        <option key={level} value={level}>
          {t(`detail.${level}`)}
        </option>
      ))}
    </select>
  )

  // Mark the trigger when a collapsed control is in a non-default state, so
  // "select mode is armed" / "zoom isn't 100%" can't hide inside the popover.
  const collapsedActive =
    (tier === "compact" && (selectMode || findOpen)) || (tier !== "wide" && zoom !== 1)

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        // Best-effort Cmd/Ctrl+F while the React chrome has focus; when the
        // native webview holds focus the toolbar Find button is the trigger.
        if (isFindShortcut(e)) {
          if (!committedUrl) return
          e.preventDefault()
          setFindOpen(true)
        }
      }}
    >
      <div
        ref={toolbarRef}
        className="relative flex items-center gap-1.5 border-b px-2 py-1.5"
        data-testid="browser-toolbar"
        data-tier={tier}
      >
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
        <div className="flex shrink-0 items-center">
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
            <SchemeIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
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
              className={cn(
                "h-8 rounded-full border-transparent bg-muted/60 pl-8 text-sm shadow-none focus-visible:border-input focus-visible:bg-background",
                // Read mode paints the pretty form over the field instead of
                // rewriting `value`, so copying still yields the real URL and
                // focusing reveals it without a reformat flicker.
                addressDisplay && "text-transparent"
              )}
            />
            {addressDisplay && (
              <div
                aria-hidden
                data-testid="browser-url-display"
                // Same border + padding as the Input so the content boxes line
                // up to the pixel and focusing doesn't nudge the text sideways.
                className="pointer-events-none absolute inset-0 flex items-center border border-transparent pl-8 pr-3"
              >
                <span className="min-w-0 truncate text-sm">
                  {addressDisplay.host}
                  {addressDisplay.rest && (
                    <span className="text-muted-foreground">{addressDisplay.rest}</span>
                  )}
                </span>
              </div>
            )}
          </div>
        </form>
        {tier !== "compact" && <div className="flex shrink-0 items-center">{inspectActions}</div>}
        {tier === "wide" && <div className="flex shrink-0 items-center">{pageActions}</div>}
        <BrowserAgentIndicator driver={driver} lastAction={lastAction} compact={tier !== "wide"} />
        {/* `modal` is load-bearing, not a style choice: the native webview is
            always-on-top and cannot be clipped, so a non-modal popover would
            open *behind* the page. Modal makes Radix mark the rest of the app
            `aria-hidden`, which is exactly what `useRegionVisibility` watches
            to park the webview off-screen — the same path the history menu and
            the cookie dialog already rely on. */}
        <Popover modal>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("actions.more")}
              data-testid="browser-toolbar-more"
              className="relative shrink-0"
            >
              <MoreHorizontalIcon />
              {collapsedActive && (
                <span
                  aria-hidden
                  data-testid="browser-toolbar-more-active"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <div className="flex flex-col gap-2">
              {tier === "compact" && (
                <div className="flex flex-wrap items-center gap-0.5">{inspectActions}</div>
              )}
              {tier !== "wide" && (
                <div className="flex flex-wrap items-center gap-0.5">{pageActions}</div>
              )}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("detail.label")}</span>
                {detailControl}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {findOpen && <BrowserFindBarSection onSearch={runFind} onClose={closeFind} />}

      {/* Below the compact threshold a 320px side rail would leave the page
          nothing to render into, and the native webview floats above React so
          it cannot be overlaid — the rail stacks under the page instead. */}
      <div className={cn("flex min-h-0 flex-1", tier === "compact" && "flex-col")}>
        <div
          ref={reservedRef}
          className="relative min-h-0 min-w-0 flex-1"
          data-testid="browser-reserved-region"
        >
          {committedUrl && !hasPainted && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background p-6 text-center animate-in fade-in duration-200"
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
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center animate-in fade-in duration-200">
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
        {railRendered && (
          <aside
            data-testid="browser-inspection-rail"
            data-state={railWanted ? "open" : "closed"}
            role="region"
            aria-label={t("rail.label")}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget && !railWanted) setRailRendered(false)
            }}
            className={cn(
              "flex shrink-0 flex-col overflow-hidden bg-background duration-200",
              "data-[state=open]:animate-in data-[state=open]:fade-in",
              "data-[state=closed]:animate-out data-[state=closed]:fade-out",
              tier === "compact"
                ? [
                    "h-1/2 border-t",
                    "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
                  ]
                : [
                    "w-80 border-l",
                    "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
                  ]
            )}
          >
            <ScrollArea className="min-h-0 flex-1">
              {selection && (
                <div className="bg-background p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                        {selection.tagName.toLowerCase()}
                      </Badge>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {selection.componentName
                          ? `<${selection.componentName}>`
                          : selection.selector}
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
                    <div className="flex items-center gap-1">
                      <select
                        value={annotationIntent}
                        onChange={(event) =>
                          setAnnotationIntent(event.target.value as BrowserAnnotationIntent)
                        }
                        aria-label={t("annotation.intent.label")}
                        className="h-7 rounded-md border bg-background px-1 text-xs"
                      >
                        {(["fix", "change", "question", "approve"] as const).map((intent) => (
                          <option key={intent} value={intent}>
                            {t(`annotation.intent.${intent}`)}
                          </option>
                        ))}
                      </select>
                      <select
                        value={annotationSeverity}
                        onChange={(event) =>
                          setAnnotationSeverity(event.target.value as BrowserAnnotationSeverity)
                        }
                        aria-label={t("annotation.severity.label")}
                        className="h-7 rounded-md border bg-background px-1 text-xs"
                      >
                        {(["blocking", "important", "suggestion"] as const).map((severity) => (
                          <option key={severity} value={severity}>
                            {t(`annotation.severity.${severity}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sending || !comment.trim()}
                        onClick={() => void onQueue()}
                      >
                        {t("annotation.add")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={sending || !comment.trim()}
                        onClick={() => void onSend()}
                      >
                        <SendIcon className="size-3.5" />
                        {t("comment.send")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {annotationQueue.length > 0 && (
                <div className="border-t bg-muted/30 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">
                      {t("annotation.queued", { count: annotationQueue.length })}
                    </span>
                    <Button
                      size="sm"
                      disabled={sending || pendingAnnotations.length === 0}
                      onClick={() => void onSendQueue()}
                    >
                      <SendIcon className="size-3.5" />
                      {t("annotation.send", { count: pendingAnnotations.length })}
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {annotationQueue.map((annotation, index) => (
                      <div key={annotation.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          {index + 1}. {annotation.comment}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {t(`annotation.status.${annotation.status}`)}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {t(`annotation.intent.${annotation.intent}`)} ·{" "}
                          {t(`annotation.severity.${annotation.severity}`)}
                        </Badge>
                        <TooltipIconButton
                          tooltip={t("annotation.resolve")}
                          aria-label={t("annotation.resolve")}
                          size="icon-xs"
                          onClick={() => void transitionQueuedAnnotation(annotation.id, "resolved")}
                        >
                          <CheckIcon />
                        </TooltipIconButton>
                        <TooltipIconButton
                          tooltip={t("annotation.remove")}
                          aria-label={t("annotation.remove")}
                          size="icon-xs"
                          onClick={() =>
                            void transitionQueuedAnnotation(annotation.id, "dismissed")
                          }
                        >
                          <Trash2Icon />
                        </TooltipIconButton>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </ScrollArea>
          </aside>
        )}
      </div>

      <BrowserRecorderPanel
        pageUrl={currentUrl ?? null}
        onSendToChat={(markdown) => void sendText(markdown, { sessionId })}
      />
    </div>
  )
}
