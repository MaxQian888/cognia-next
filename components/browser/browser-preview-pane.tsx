"use client"

import {
  CameraIcon,
  BracesIcon,
  CheckIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MonitorXIcon,
  MousePointerSquareDashedIcon,
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
import { onBrowserUrlRequest } from "@/lib/browser/open-url-request"
import { BrowserCookieImportAction } from "@/components/browser/browser-cookie-import-action"
import { BrowserAdjustControls } from "@/components/browser/browser-adjust-controls"
import { BrowserCdpControls } from "@/components/browser/browser-cdp-controls"
import { BrowserFindBarSection, isFindShortcut } from "@/components/browser/browser-find-bar"
import { BrowserHistoryMenu } from "@/components/browser/browser-history-menu"
import { BrowserNavigationControls } from "@/components/browser/browser-navigation-controls"
import { BrowserRecorderPanel } from "@/components/browser/browser-recorder-panel"
import {
  BrowserConsolePanel,
  BrowserNetworkPanel,
} from "@/components/browser/browser-devtools-panels"
import { BrowserEmptyState } from "@/components/browser/browser-empty-state"
import {
  BrowserToolbar,
  addressDisplayParts,
  toolbarTier,
} from "@/components/browser/browser-toolbar"
import { BrowserToolsDock } from "@/components/browser/browser-tools-dock"
import { useBrowserDevtools } from "@/hooks/browser/use-browser-devtools"
import { BrowserWebFallback } from "@/components/browser/browser-web-fallback"
import { BrowserZoomControl, MAX_ZOOM, MIN_ZOOM } from "@/components/browser/browser-zoom-control"
import { RemoteBrowserPreview } from "@/components/browser/remote-browser-preview"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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
  toBrowserNavIntent,
} from "@/lib/browser/protocol"
import { resolveDesktopBackend, type BrowserBackend } from "@/lib/browser/backend-availability"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { isTauri } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import { serializeBrowserAdjustmentFeedback } from "@/lib/browser/adjust"
import type { BrowserAdjustmentFeedback } from "@/types/browser-developer"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

const DETAIL_LEVEL_STORAGE_KEY = "cognia.browser.output-detail"
const ZOOM_STORAGE_KEY = "cognia.browser.zoom"
const DETAIL_LEVELS: OutputDetailLevel[] = ["compact", "standard", "detailed", "forensic"]

/** Host of a URL for display, or the raw string / "" if it can't be parsed. */
function hostOf(url: string | null): string {
  if (!url) return ""
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export { addressDisplayParts }

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
  requestedUrl,
  requestId,
  ownerId,
  onRequestReveal,
}: {
  sessionId?: string
  parentChatSessionId?: string
  workspaceId?: string
  profileId?: string
  initialUrl?: string
  /**
   * An address a host is asking this pane to go to *now*, e.g. the link a user
   * just clicked in the conversation.
   *
   * Distinct from `initialUrl`, which seeds the pane once and is meaningless
   * afterwards. A host whose panel was never mounted cannot route a link
   * through `onBrowserUrlRequest` (there is nothing subscribed yet), so it
   * reveals the panel and states the address here instead. Every change is
   * applied, and only the native branch shares state with the toolbar, which
   * is why this is threaded down to the web and remote surfaces rather than
   * left in `committedUrl`.
   */
  requestedUrl?: string
  /**
   * Which request `requestedUrl` belongs to. Re-stating the same address is a
   * new request, and only this distinguishes the two — see
   * `browserRequestId` in `artifact-dock-layout-store`.
   */
  requestId?: number
  ownerId?: string
  /**
   * Bring this pane's surface to the front, returning whether it worked. Only
   * a host that can be hidden while still mounted needs to supply it — see the
   * `onBrowserUrlRequest` handler below.
   */
  onRequestReveal?: () => boolean
}) {
  const t = useTranslations("browser")
  const tCdp = useTranslations("browserCdp")
  const normalizedInitialUrl = initialUrl ? normalizePreviewUrl(initialUrl) : null
  const reservedRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState(normalizedInitialUrl ?? "")
  const [editingUrl, setEditingUrl] = useState(false)
  const [committedUrl, setCommittedUrl] = useState<string | null>(normalizedInitialUrl)
  /**
   * The address the web and remote surfaces follow.
   *
   * They render their own toolbars and never read `committedUrl`, which only
   * the native branch shares with the toolbar above it, so this is the one
   * field all three branches agree on. Both routes write it: the `requestedUrl`
   * prop below, and `openQuickUrl` when a visible pane claims a link itself.
   */
  const [surfaceRequest, setSurfaceRequest] = useState<{ url: string; nonce: number } | null>(
    normalizedInitialUrl ? { url: normalizedInitialUrl, nonce: 0 } : null
  )
  /**
   * Which request has already been consumed.
   *
   * Kept apart from `surfaceRequest` deliberately. Folding the two together let
   * the prop win back a page the user had just navigated away from: a claim
   * through `openQuickUrl` moved the shared field, the prop no longer matched
   * it, and the very next render "re-applied" the stale address on top of the
   * new one.
   *
   * Keyed on the request token as well as the address, because the same link
   * clicked twice is two requests. Comparing addresses alone made the second
   * click a no-op whenever the user had browsed elsewhere in between — the very
   * case where re-opening it is the whole point.
   */
  const normalizedRequestedUrl = requestedUrl ? normalizePreviewUrl(requestedUrl) : null
  const requestKey = normalizedRequestedUrl ? `${requestId ?? 0}:${normalizedRequestedUrl}` : null
  const [consumedRequestKey, setConsumedRequestKey] = useState<string | null>(null)
  // Applied during render rather than from an effect: the address is a prop and
  // this state is derived from it. An effect would paint one frame of the
  // previous page first, which on the native branch is a real navigation.
  if (normalizedRequestedUrl && requestKey !== consumedRequestKey) {
    setConsumedRequestKey(requestKey)
    setUrlInput(normalizedRequestedUrl)
    setCommittedUrl(normalizedRequestedUrl)
    setSurfaceRequest((previous) => ({
      url: normalizedRequestedUrl,
      nonce: (previous?.nonce ?? 0) + 1,
    }))
  }
  const [comment, setComment] = useState("")
  const [acceptedAdjustment, setAcceptedAdjustment] = useState<{
    pageUrl: string
    feedback: BrowserAdjustmentFeedback
  } | null>(null)
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
  const [webviewReady, setWebviewReady] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  // ADR-0127: console / network rings for the DevTools drawer. Gated on the
  // lease below so a second mounted pane does not mirror the owner's feeds.
  // Opening developer mode now selects a tab in the bottom dock rather than
  // toggling a second surface in the side rail. `null` means "no outstanding
  // request", so the dock can be collapsed again without this re-opening it.
  const [developerRequest, setDeveloperRequest] = useState(0)
  const {
    recent: recentHistory,
    push: pushHistory,
    replace: replaceHistory,
    traverseTo: traverseHistory,
    goBack: historyGoBack,
    goForward: historyGoForward,
    canGoBack,
    canGoForward,
    clear: clearHistory,
  } = useBrowserHistory()
  const activeChatSessionId = useChatStore((state) => state.activeSessionId)
  /**
   * The chat session this pane's annotations, CDP grants and Adjust drafts
   * belong to.
   *
   * `useSelectionToChat` already falls back to the focused session for every
   * write it performs, so a pane that read only the `sessionId` prop disagreed
   * with the code it called: on `/browser` and in the sites publish tab —
   * neither of which passes one — "Add to queue" happily wrote an annotation
   * under the active session while the queue that displays it stayed pinned to
   * `undefined`, stranding the row for its full 30-day retention. The developer
   * panel and Browser Adjust were simply unreachable there for the same reason.
   * One derived id keeps writer and reader in agreement.
   */
  const effectiveSessionId = sessionId ?? activeChatSessionId ?? undefined
  const annotationQueue =
    useLiveQuery(
      () =>
        effectiveSessionId
          ? listActionableBrowserAnnotations(effectiveSessionId)
          : Promise.resolve([]),
      [effectiveSessionId],
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
  const {
    phase,
    hasPainted,
    loadedUrl,
    begin: beginLoad,
  } = useBrowserLoading({
    url: committedUrl,
  })
  const regionVisible = useRegionVisibility(reservedRef)
  // `owned` is resolved by `useBrowserPaneWebview` below; the visibility it
  // consumes is computed there from the same three inputs plus the lease.

  const handleWebviewReady = useCallback(() => setWebviewReady(true), [])
  const handleWebviewError = useCallback(
    (error: unknown) => {
      if (String(error).includes("PROXY_TRANSPORT_UNSUPPORTED")) {
        toast.error(t("errors.httpsProxyUnsupported"))
        return
      }
      toast.error(t("errors.navigate"))
    },
    [t]
  )
  const { getRect, refreshBounds, owned, takeLease } = useBrowserPaneWebview(reservedRef, {
    url: committedUrl,
    ownerId,
    onReady: handleWebviewReady,
    onError: handleWebviewError,
    onRectChange: handleRectChange,
    visible: !!committedUrl && hasPainted && regionVisible,
    // The same nonce the web and remote surfaces follow. `committedUrl` alone
    // cannot express "go to A again": React bails out of the identical
    // `setState`, so a pane whose page had drifted to B (an in-page navigation,
    // a redirect) stayed on B while every other backend went back to A.
    navigateNonce: surfaceRequest?.nonce ?? 0,
  })
  const devtools = useBrowserDevtools({ paneId: "browser-embed", enabled: owned })
  const { selection, selections, navigated, selectMode, setSelectMode, clearSelection } =
    useElementSelection({ driver: browserClient.embedSetSelectMode, enabled: owned })
  const { sendComment, queueAnnotation, sendAnnotations, sendScreenshot, sendText } =
    useSelectionToChat()
  const { driver, lastAction } = useBrowserAgentActivity()
  const toolbarWidth = useElementWidth(toolbarRef)
  const remoteBrowserEnabled = useSettingsStore(
    (state) => state.settings?.remoteBrowserEnabled ?? false
  )
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  // Desktop keeps the embedded webview by default and offers remote as a
  // switch; off the desktop the sandboxed iframe is the fallback.
  const [backendPreference, setBackendPreference] = useState<BrowserBackend | null>(null)
  const backend = resolveDesktopBackend(
    {
      tauri: isTauri(),
      remoteBrowserEnabled,
      remoteHostActive: isRemoteHostActive(),
      webCompanionTarget: hasWebCompanionTarget(),
    },
    backendPreference
  )

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
    if (owned && committedUrl && hasPainted && regionVisible && webviewReady) {
      void browserClient.embedSetZoom(zoom).catch(() => {})
    }
  }, [owned, committedUrl, hasPainted, regionVisible, webviewReady, zoom])
  useEffect(() => {
    void deleteExpiredBrowserAnnotations(new Date().getTime())
  }, [])

  // The in-page info panel (drawn by the injected overlay) can't reach next-intl,
  // so push its localized toggle labels down once the preview webview exists.
  const panelDetailsLabel = t("panel.details")
  const panelCollapseLabel = t("panel.collapse")
  useEffect(() => {
    if (!isTauri() || !owned || !committedUrl || !webviewReady) return
    void browserClient
      .embedSetPanelLabels({ details: panelDetailsLabel, collapse: panelCollapseLabel })
      .catch(() => {})
  }, [owned, committedUrl, panelDetailsLabel, panelCollapseLabel, webviewReady])

  // The preview's real location (follows in-page navigations and redirects).
  const currentUrl = navigated?.url ?? committedUrl
  const adjustmentFeedback =
    acceptedAdjustment?.pageUrl === currentUrl ? acceptedAdjustment.feedback : null
  const acceptAdjustment = useCallback(
    (feedback: BrowserAdjustmentFeedback) => {
      if (!currentUrl) return
      setAcceptedAdjustment({ pageUrl: currentUrl, feedback })
    },
    [currentUrl]
  )

  const tier = toolbarTier(toolbarWidth)

  /**
   * A back/forward we initiated. The page cannot tell us that a document load
   * is the result of `history.back()` — a cross-document traversal reports
   * exactly like a fresh navigation — so the pane remembers the address it
   * asked for and lets that one arrival past without touching the stack.
   */
  const expectedTraversalRef = useRef<string | null>(null)
  const consumeExpectedTraversal = useCallback((url: string) => {
    if (expectedTraversalRef.current !== url) return false
    expectedTraversalRef.current = null
    return true
  }, [])

  // A settled document is the only reliable "we have arrived" signal: a
  // redirect chain emits one `browser://navigated` per hop but settles once.
  useEffect(() => {
    if (!loadedUrl) return
    if (consumeExpectedTraversal(loadedUrl)) return
    pushHistory(loadedUrl)
  }, [loadedUrl, pushHistory, consumeExpectedTraversal])

  // Same-document route changes never settle, so they update the stack
  // directly — and how they update it depends on what the page actually did.
  useEffect(() => {
    if (!navigated?.url || navigated.kind !== "spa") return
    const url = navigated.url
    if (consumeExpectedTraversal(url)) return
    switch (toBrowserNavIntent(navigated.intent)) {
      case "replace":
        replaceHistory(url)
        break
      case "traverse":
        traverseHistory(url)
        break
      default:
        pushHistory(url)
    }
  }, [navigated, pushHistory, replaceHistory, traverseHistory, consumeExpectedTraversal])

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
    setAcceptedAdjustment(null)
    void browserClient.embedClearSelection().catch(() => {})
  }, [clearSelection])

  const onQueue = useCallback(async () => {
    if (!selection || (!comment.trim() && !adjustmentFeedback)) return
    setSending(true)
    try {
      const baseUrl = new URL(currentUrl ?? selection.pageUrl).origin
      const feedbackPayload = adjustmentFeedback
        ? serializeBrowserAdjustmentFeedback(adjustmentFeedback)
        : ""
      const outgoingComment = [comment.trim(), feedbackPayload].filter(Boolean).join("\n\n")
      const targets = selections.length > 0 ? selections : [selection]
      const annotations = await Promise.all(
        targets.map((target) =>
          queueAnnotation(target, outgoingComment, {
            sessionId: effectiveSessionId,
            baseUrl,
            intent: annotationIntent,
            severity: annotationSeverity,
          })
        )
      )
      const saved = annotations.filter((item) => item != null)
      if (saved.length > 0) {
        setComment("")
        setAcceptedAdjustment(null)
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
    effectiveSessionId,
    queueAnnotation,
    clearSelection,
    t,
    annotationIntent,
    annotationSeverity,
    adjustmentFeedback,
  ])

  const onSend = useCallback(async () => {
    if (!selection || (!comment.trim() && !adjustmentFeedback)) return
    setSending(true)
    try {
      const feedbackPayload = adjustmentFeedback
        ? serializeBrowserAdjustmentFeedback(adjustmentFeedback)
        : ""
      const outgoingComment = [comment.trim(), feedbackPayload].filter(Boolean).join("\n\n")
      const ok = await sendComment(
        selections.length > 0 ? selections : selection,
        outgoingComment,
        {
          sessionId: effectiveSessionId,
          captureRect: getRect() ?? undefined,
          detailLevel,
        }
      )
      if (ok) {
        toast.success(t("comment.sent"))
        setComment("")
        setAcceptedAdjustment(null)
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
    effectiveSessionId,
    getRect,
    sendComment,
    clearSelection,
    t,
    detailLevel,
    adjustmentFeedback,
  ])

  const onSendQueue = useCallback(async () => {
    setSending(true)
    try {
      const ok = await sendAnnotations(pendingAnnotations, {
        sessionId: effectiveSessionId,
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
  }, [pendingAnnotations, effectiveSessionId, getRect, sendAnnotations, t, detailLevel])

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
      const ok = await sendScreenshot(rect, {
        sessionId: effectiveSessionId,
        pageUrl: currentUrl ?? undefined,
      })
      if (ok) toast.success(t("screenshot.sent"))
      else toast.error(t("comment.noSession"))
    } catch {
      toast.error(t("screenshot.failed"))
    } finally {
      setCapturing(false)
    }
  }, [getRect, sendScreenshot, effectiveSessionId, currentUrl, t])

  const openQuickUrl = useCallback((url: string) => {
    setUrlInput(url)
    setCommittedUrl(url)
    // Left out, a claim made by a *visible* pane on the web or remote shell set
    // state that nothing rendered, and the link looked like it did nothing.
    // The nonce is what makes re-claiming the address the pane already holds a
    // real state change: without it, going A → (browse to B) → A again wrote
    // the identical value, React bailed out, and the surface stayed on B.
    setSurfaceRequest((previous) => ({ url, nonce: (previous?.nonce ?? 0) + 1 }))
  }, [])

  // ⌘-clicking a link in the composer lands here rather than in the OS browser.
  //
  // Claiming is what tells the caller not to fall back to the OS browser, so a
  // pane may only claim when the user will actually SEE the result. Being
  // mounted is not that: dock panels are `retention: "stateful"`, so the
  // browser panel stays mounted behind whichever tab is showing, and a claim
  // from there navigates a pane nobody can look at — which reads as the link
  // silently doing nothing. `regionVisible` already answers this correctly
  // (it watches aria-hidden / inert / modal / portal occlusion); a host that
  // can reveal itself gets one chance to do so first.
  const revealRef = useRef(onRequestReveal)
  useEffect(() => {
    revealRef.current = onRequestReveal
  }, [onRequestReveal])
  const regionVisibleRef = useRef(regionVisible)
  useEffect(() => {
    regionVisibleRef.current = regionVisible
  }, [regionVisible])
  useEffect(
    () =>
      onBrowserUrlRequest((url) => {
        const normalized = normalizePreviewUrl(url)
        if (!normalized) return false
        if (!regionVisibleRef.current && revealRef.current?.() !== true) return false
        openQuickUrl(normalized)
        return true
      }),
    [openQuickUrl]
  )

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
  // Which engine this shell can serve. The choice used to be made on the shell
  // (`!isTauri()`), which meant a desktop attached to a remote Cognia host —
  // the one place the cloud browser is genuinely reachable from the desktop —
  // could never select it, and the browser profiles and domain grants in
  // Settings did nothing there. See `lib/browser/backend-availability.ts`.
  if (backend.backend === "remote") {
    return (
      <RemoteBrowserPreview
        chatSessionId={effectiveSessionId ?? "browser-preview"}
        parentChatSessionId={parentChatSessionId}
        workspaceId={workspaceId ?? activeProjectId ?? "default"}
        profileId={profileId}
        initialUrl={normalizedInitialUrl ?? undefined}
        requestedUrl={surfaceRequest?.url}
        requestNonce={surfaceRequest?.nonce}
      />
    )
  }
  if (!isTauri()) {
    return (
      <BrowserWebFallback
        initialUrl={normalizedInitialUrl ?? undefined}
        requestedUrl={surfaceRequest?.url}
        requestNonce={surfaceRequest?.nonce}
        unreachableReason={
          backend.reason === "no-remote-host" ? t("remote.needsRemoteHost") : undefined
        }
      />
    )
  }

  // Read-mode address: only while the field still mirrors the live location.
  // An uncommitted draft is never rewritten under the user's cursor.
  //
  // No focus term here. `BrowserToolbar` drops the overlay itself whenever the
  // field has focus, for every caller — repeating the rule here would be a
  // second copy of it that the toolbar's would silently overrule anyway.
  // `editingUrl` still guards the live-location sync above, which is a
  // different question.
  const addressDisplay = urlInput !== (currentUrl ?? "") ? null : addressDisplayParts(urlInput)

  // Every control below that issues a `browserClient` command needs the lease:
  // without it the native side answers "owner token does not match", and most
  // of those calls are un-awaited, so the rejection surfaces as an unhandled
  // promise rather than as anything the user can act on. Disabling them is the
  // honest form — the takeover button in the reserved region is the way back.
  const nativeReady = !!committedUrl && owned

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
        disabled={!nativeReady || capturing}
        onClick={() => void onScreenshot()}
      >
        <CameraIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={selectMode ? t("actions.cancelSelect") : t("actions.selectElement")}
        aria-label={selectMode ? t("actions.cancelSelect") : t("actions.selectElement")}
        disabled={!nativeReady}
        className={cn(selectMode && "bg-primary/15 text-primary")}
        onClick={() => void setSelectMode(!selectMode)}
      >
        <MousePointerSquareDashedIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={t("actions.find")}
        aria-label={t("actions.find")}
        disabled={!nativeReady}
        className={cn(findOpen && "bg-primary/15 text-primary")}
        onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
      >
        <SearchIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={tCdp("title")}
        aria-label={tCdp("title")}
        disabled={!nativeReady || !effectiveSessionId}
        onClick={() => setDeveloperRequest((n) => n + 1)}
      >
        <BracesIcon />
      </TooltipIconButton>
    </>
  )

  // Page-setup actions: set once and left alone, so they collapse first.
  const pageActions = (
    <>
      <BrowserZoomControl zoom={zoom} onZoomChange={setZoom} disabled={!nativeReady} />
      <BrowserCookieImportAction
        currentUrl={owned ? currentUrl : null}
        onReload={reloadAfterCookieImport}
      />
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
    <NativeSelect
      value={detailLevel}
      onChange={(event) => setDetailLevel(event.target.value as OutputDetailLevel)}
      aria-label={t("detail.label")}
      size="sm"
      wrapperClassName="w-full"
      className="h-7 text-xs"
    >
      {DETAIL_LEVELS.map((level) => (
        <NativeSelectOption key={level} value={level}>
          {t(`detail.${level}`)}
        </NativeSelectOption>
      ))}
    </NativeSelect>
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
          if (!nativeReady) return
          e.preventDefault()
          setFindOpen(true)
        }
      }}
    >
      <BrowserToolbar
        toolbarRef={toolbarRef}
        loading={phase === "loading"}
        url={urlInput}
        onUrlChange={setUrlInput}
        onSubmit={commitUrl}
        onUrlKeyDown={onUrlKeyDown}
        onUrlFocus={() => setEditingUrl(true)}
        onUrlBlur={() => setEditingUrl(false)}
        urlInputRef={urlInputRef}
        addressDisplay={addressDisplay}
        collapsedActive={collapsedActive}
        inspectActions={inspectActions}
        pageActions={pageActions}
        overflowExtras={
          <>
            {backend.remoteReachable && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("backend.label")}</span>
                <NativeSelect
                  value={backend.backend}
                  onChange={(event) => setBackendPreference(event.target.value as BrowserBackend)}
                  aria-label={t("backend.label")}
                  size="sm"
                  wrapperClassName="w-full"
                  className="h-7 text-xs"
                >
                  <NativeSelectOption value="embedded">{t("backend.embedded")}</NativeSelectOption>
                  <NativeSelectOption value="remote">{t("backend.remote")}</NativeSelectOption>
                </NativeSelect>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("detail.label")}</span>
              {detailControl}
            </div>
          </>
        }
        trailing={
          <BrowserAgentIndicator
            driver={driver}
            lastAction={lastAction}
            compact={tier !== "wide"}
          />
        }
        navigation={
          <BrowserNavigationControls
            disabled={!nativeReady}
            backDisabled={!canGoBack}
            forwardDisabled={!canGoForward}
            loading={phase === "loading"}
            onBack={() => {
              const target = historyGoBack()
              if (!target) return
              expectedTraversalRef.current = target
              beginLoad()
              void browserClient.embedBack()
            }}
            onForward={() => {
              const target = historyGoForward()
              if (!target) return
              expectedTraversalRef.current = target
              beginLoad()
              void browserClient.embedForward()
            }}
            onReload={() => {
              beginLoad()
              void browserClient.embedReload()
            }}
            onStop={() => {
              void browserClient.embedStop().catch(() => {})
            }}
          />
        }
      />

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
          {!owned && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center animate-in fade-in duration-200"
              role="status"
              aria-live="polite"
              data-testid="browser-lease-busy"
            >
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                <MonitorXIcon className="size-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">{t("lease.busyTitle")}</p>
                <p className="max-w-sm text-xs text-muted-foreground">{t("lease.busyHint")}</p>
              </div>
              <Button size="sm" variant="outline" onClick={takeLease}>
                {t("lease.takeOver")}
              </Button>
            </div>
          )}
          {owned && committedUrl && !hasPainted && (
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
          {owned && !committedUrl && <BrowserEmptyState onOpen={openQuickUrl} />}
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
                  {/* The Esc / Ctrl+Enter bindings in `onCommentKeyDown` have
                      always worked; nothing ever told the user about them. */}
                  <p className="mt-1 text-[11px] text-muted-foreground">{t("comment.hint")}</p>
                  {currentUrl && effectiveSessionId && (
                    <BrowserAdjustControls
                      sessionId={effectiveSessionId}
                      browserSessionId={ownerId ?? `browser:${effectiveSessionId}`}
                      pageUrl={currentUrl}
                      selector={selection.selector}
                      onAccept={acceptAdjustment}
                    />
                  )}
                  {adjustmentFeedback && (
                    <p className="mt-1 text-xs text-muted-foreground">{t("adjust.accepted")}</p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <NativeSelect
                        value={annotationIntent}
                        onChange={(event) =>
                          setAnnotationIntent(event.target.value as BrowserAnnotationIntent)
                        }
                        aria-label={t("annotation.intent.label")}
                        size="sm"
                        className="h-7 text-xs"
                      >
                        {(["fix", "change", "question", "approve"] as const).map((intent) => (
                          <NativeSelectOption key={intent} value={intent}>
                            {t(`annotation.intent.${intent}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <NativeSelect
                        value={annotationSeverity}
                        onChange={(event) =>
                          setAnnotationSeverity(event.target.value as BrowserAnnotationSeverity)
                        }
                        aria-label={t("annotation.severity.label")}
                        size="sm"
                        className="h-7 text-xs"
                      >
                        {(["blocking", "important", "suggestion"] as const).map((severity) => (
                          <NativeSelectOption key={severity} value={severity}>
                            {t(`annotation.severity.${severity}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sending || (!comment.trim() && !adjustmentFeedback)}
                        onClick={() => void onQueue()}
                      >
                        {t("annotation.add")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={sending || (!comment.trim() && !adjustmentFeedback)}
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

      {/* One collapsed strip for the recorder, the ADR-0127 console / network
          readouts and developer mode — and only once a page is committed, so an
          empty pane spends nothing on it. */}
      {committedUrl && (
        <BrowserToolsDock
          onLayoutChange={refreshBounds}
          openRequest={developerRequest > 0 ? { tab: "developer", nonce: developerRequest } : null}
          consoleCount={devtools.console.length}
          networkCount={devtools.network.length}
          problemCount={devtools.problemCount}
          failedRequests={devtools.failedRequests}
          recorder={
            <BrowserRecorderPanel
              chrome={false}
              pageUrl={currentUrl ?? null}
              onLayoutChange={refreshBounds}
              onSendToChat={(markdown) =>
                void sendText(markdown, { sessionId: effectiveSessionId })
              }
            />
          }
          console={
            <BrowserConsolePanel entries={devtools.console} onClear={devtools.clearConsole} />
          }
          network={
            <BrowserNetworkPanel entries={devtools.network} onClear={devtools.clearNetwork} />
          }
          developer={
            currentUrl && effectiveSessionId ? (
              <BrowserCdpControls
                sessionId={effectiveSessionId}
                browserSessionId={ownerId ?? `browser:${effectiveSessionId}`}
                pageUrl={currentUrl}
              />
            ) : undefined
          }
        />
      )}
    </div>
  )
}
