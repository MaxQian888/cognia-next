"use client"

import {
  CameraIcon,
  BracesIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MonitorXIcon,
  MousePointerSquareDashedIcon,
  SearchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  BrowserAgentIndicator,
  useBrowserAgentActivity,
} from "@/components/browser/browser-agent-indicator"
import { onBrowserUrlRequest } from "@/lib/browser/open-url-request"
import { BrowserCookieImportAction } from "@/components/browser/browser-cookie-import-action"
import { BrowserInspectionRail } from "@/components/browser/browser-inspection-rail"
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
import { BrowserLoadError } from "@/components/browser/browser-load-error"
import { BrowserBackendSwitcher } from "@/components/browser/browser-backend-switcher"
import { BrowserDownloadsButton } from "@/components/browser/browser-downloads-panel"
import { BrowserEngineChip } from "@/components/browser/browser-engine-chip"
import { LocalChromiumPreview } from "@/components/browser/local-chromium-preview"
import { BrowserAutofillPrompt } from "@/components/browser/vault/browser-autofill-prompt"
import {
  BrowserToolbar,
  addressDisplayParts,
  toolbarTier,
} from "@/components/browser/browser-toolbar"
import { BrowserToolsDock } from "@/components/browser/browser-tools-dock"
import { useBrowserDevtools } from "@/hooks/browser/use-browser-devtools"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import { BrowserWebFallback } from "@/components/browser/browser-web-fallback"
import { BrowserZoomControl, MAX_ZOOM, MIN_ZOOM } from "@/components/browser/browser-zoom-control"
import { RemoteBrowserPreview } from "@/components/browser/remote-browser-preview"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { useElementWidth } from "@/hooks/use-element-width"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useRecentPages } from "@/hooks/browser/use-recent-pages"
import { useBrowserLoading } from "@/hooks/browser/use-browser-loading"
import { useBrowserPaneWebview } from "@/hooks/browser/use-browser-pane-webview"
import { useElementSelection } from "@/hooks/browser/use-element-selection"
import { useRegionVisibility } from "@/hooks/browser/use-region-visibility"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { browserClient } from "@/lib/browser/client"
import { setActivePaneRect } from "@/lib/browser/pane-rect"
import { BROWSER_DETAIL_STORAGE_KEY, BROWSER_ZOOM_STORAGE_KEY } from "@/lib/browser/preview-data"
import {
  type ElementRect,
  type OutputDetailLevel,
  normalizePreviewUrl,
  resolveTrustTier,
  toBrowserNavIntent,
} from "@/lib/browser/protocol"
import { resolveDesktopBackend, type BrowserBackend } from "@/lib/browser/backend-availability"
import { primeLocalBrowserRouting, setLocalChromiumInstalled } from "@/lib/browser/agent-engine"
import { localPathFromAddress, serveLocalFile } from "@/lib/browser/local-content-client"
import type { UserChromeBrowser } from "@/lib/browser/local-client"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { useRemoteHostActive } from "@/hooks/use-host-profile"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import { dockPageEngineFor } from "@/lib/artifacts/dock-pages"
import type { DockPageEngine } from "@/stores/artifact/dock-tabs-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

const DETAIL_LEVELS: OutputDetailLevel[] = ["compact", "standard", "detailed", "forensic"]

/** `settings.browserDefaultBackend` as a preference: `auto` / absent is none. */
function defaultBackendPreference(value: string | undefined): BrowserBackend | null {
  switch (value) {
    case "embedded":
    case "local-chromium":
    case "user-chrome":
    case "remote":
      return value
    default:
      return null
  }
}

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
 * A chat dock page tab the pane shows (ADR-0214). The tab, not the pane, holds
 * the engine choice and the address, so both survive the pane remounting for
 * every tab switch.
 */
export interface BrowserDockPage {
  /** Whose pages these are in the shared Chromium session (`chat:<id>`). */
  owner: string
  tabId: string
  engine: DockPageEngine
  onEngineChange: (engine: DockPageEngine) => void
  /** Where the lightweight preview went, so the tab can remember it. */
  onNavigated?: (url: string) => void
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
  initialUrl,
  requestedUrl,
  requestId,
  ownerId,
  onRequestReveal,
  dockPage,
}: {
  sessionId?: string
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
  /**
   * Show one chat dock page tab. The dock routes links itself (a link becomes
   * a tab), so a docked pane never claims URL requests.
   */
  dockPage?: BrowserDockPage
}) {
  const t = useTranslations("browser")
  const tCdp = useTranslations("browserCdp")
  const tLocal = useTranslations("browserLocal")
  const normalizedInitialUrl = initialUrl ? normalizePreviewUrl(initialUrl) : null
  const reservedRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState(normalizedInitialUrl ?? "")
  const [editingUrl, setEditingUrl] = useState(false)
  const [committedUrl, setCommittedUrl] = useState<string | null>(normalizedInitialUrl)
  const [loadError, setLoadError] = useState<{ url: string; message: string } | null>(null)
  const [loadingUrl, setLoadingUrl] = useState(normalizedInitialUrl)
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
    setLoadError(null)
    setLoadingUrl(normalizedRequestedUrl)
    setConsumedRequestKey(requestKey)
    setUrlInput(normalizedRequestedUrl)
    setCommittedUrl(normalizedRequestedUrl)
    setSurfaceRequest((previous) => ({
      url: normalizedRequestedUrl,
      nonce: (previous?.nonce ?? 0) + 1,
    }))
  }
  const [capturing, setCapturing] = useState(false)
  const [detailLevel, setDetailLevel] = useState<OutputDetailLevel>(() => {
    if (typeof window === "undefined") return "standard"
    const stored = window.localStorage.getItem(BROWSER_DETAIL_STORAGE_KEY)
    return DETAIL_LEVELS.includes(stored as OutputDetailLevel)
      ? (stored as OutputDetailLevel)
      : "standard"
  })
  const [zoom, setZoom] = useState<number>(() => {
    if (typeof window === "undefined") return 1
    const stored = Number(window.localStorage.getItem(BROWSER_ZOOM_STORAGE_KEY))
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
  /** The live take's step count, for the dock header; null when not recording. */
  const [recordingSteps, setRecordingSteps] = useState<number | null>(null)
  const {
    push: pushHistory,
    replace: replaceHistory,
    traverseTo: traverseHistory,
    goBack: historyGoBack,
    goForward: historyGoForward,
    canGoBack,
    canGoForward,
  } = useBrowserHistory()
  const { recent: recentHistory, clear: clearRecentPages } = useRecentPages()
  const clearHistory = useCallback(() => {
    void clearRecentPages().then((cleared) => {
      if (!cleared) toast.error(t("history.clearFailed"))
    })
  }, [clearRecentPages, t])
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
    begin: startLoad,
    fail: failLoad,
    reveal: revealPage,
  } = useBrowserLoading({
    url: committedUrl,
    navigateNonce: surfaceRequest?.nonce,
  })
  const beginLoad = useCallback(
    (url?: string | null) => {
      setLoadingUrl(url ?? committedUrl)
      setLoadError(null)
      startLoad()
    },
    [startLoad, committedUrl]
  )
  const regionVisible = useRegionVisibility(reservedRef)
  // `owned` is resolved by `useBrowserPaneWebview` below; the visibility it
  // consumes is computed there from the same three inputs plus the lease.

  const remoteBrowserEnabled = useSettingsStore(
    (state) => state.settings?.remoteBrowserEnabled ?? false
  )
  const settingsDefaultBackend = useSettingsStore((state) => state.settings?.browserDefaultBackend)
  const settingsUserChromeBrowser = useSettingsStore(
    (state) => state.settings?.browserUserChromeBrowser ?? null
  )
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  // ADR-0201: four desktop engines. The preference is the user's pick in the
  // pane, else the Settings default; `resolveDesktopBackend` serves it when it
  // can and falls back (embedded) when it can't. Off the desktop the sandboxed
  // iframe is the fallback.
  const local = useLocalBrowser()
  const localInstalled = local.status?.installed ?? false
  const [paneBackendPreference, setPaneBackendPreference] = useState<BrowserBackend | null>(null)
  const settingsPreference = defaultBackendPreference(settingsDefaultBackend)
  // A dock page tab carries its own engine; `auto` is the Settings default.
  const backendPreference = dockPage
    ? dockPage.engine === "auto"
      ? settingsPreference
      : dockPage.engine
    : (paneBackendPreference ?? settingsPreference)
  const dockEngineChangeRef = useRef(dockPage?.onEngineChange)
  useEffect(() => {
    dockEngineChangeRef.current = dockPage?.onEngineChange
  }, [dockPage?.onEngineChange])
  const docked = Boolean(dockPage)
  const setBackendPreference = useCallback(
    (backend: BrowserBackend | null) => {
      const toTab = dockEngineChangeRef.current
      if (docked && toTab) toTab(backend ? dockPageEngineFor(backend) : "auto")
      else setPaneBackendPreference(backend)
    },
    [docked]
  )
  const [paneUserChromeBrowser, setUserChromeBrowser] = useState<string | null>(null)
  const userChromeBrowser = paneUserChromeBrowser ?? settingsUserChromeBrowser
  const userChromeCandidate =
    local.userChrome.find((candidate) => candidate.browser === userChromeBrowser) ??
    local.userChrome.find((candidate) => candidate.available) ??
    null
  // No address yet: an empty pane stays on the lightweight webview instead of
  // spawning Chromium for nothing.
  const targetUrl = surfaceRequest?.url ?? committedUrl
  // Subscribed rather than read once: a desktop can attach to or detach from a
  // remote host while the pane is open, and that decides whether the remote
  // engine is reachable at all. A one-shot read kept the previous answer (and
  // with it the engine choice) until something unrelated re-rendered the pane.
  const remoteHostActive = useRemoteHostActive()
  const backend = resolveDesktopBackend(
    {
      tauri: isTauri(),
      remoteBrowserEnabled,
      remoteHostActive,
      webCompanionTarget: hasWebCompanionTarget(),
      localChromiumInstalled: localInstalled,
      userChromeAvailable: userChromeCandidate?.available ?? false,
      ...(targetUrl ? { targetTier: resolveTrustTier(targetUrl) } : {}),
      idle: !targetUrl,
    },
    backendPreference
  )
  const embeddedActive = isTauri() && backend.backend === "embedded"
  /** Whether a requested engine can be served right now (for URL requests). */
  const canServeBackendRef = useRef<(wanted: BrowserBackend) => boolean>(() => false)
  useEffect(() => {
    canServeBackendRef.current = (wanted) => {
      switch (wanted) {
        case "embedded":
          return isTauri()
        case "local-chromium":
          return backend.localReachable
        case "user-chrome":
          return backend.userChromeReachable
        case "remote":
          return backend.remoteReachable
        default:
          return false
      }
    }
  }, [backend.localReachable, backend.userChromeReachable, backend.remoteReachable])
  // Download history is fed app-wide (`BrowserDownloadsInitializer`), so a
  // headless agent session's downloads land there with no pane open.

  // Agent routing reads the install state synchronously; keep it current.
  useEffect(() => {
    void primeLocalBrowserRouting()
  }, [])
  useEffect(() => {
    if (local.status) setLocalChromiumInstalled(local.status.installed)
  }, [local.status])

  const handleWebviewReady = useCallback(() => setWebviewReady(true), [])
  const handleWebviewError = useCallback(
    (error: unknown, failedUrl?: string) => {
      const message = String(error).includes("PROXY_TRANSPORT_UNSUPPORTED")
        ? t("errors.httpsProxyUnsupported")
        : t("loadError.hint")
      setLoadError({ url: failedUrl ?? loadingUrl ?? committedUrl ?? "", message })
      failLoad()
      toast.error(
        String(error).includes("PROXY_TRANSPORT_UNSUPPORTED") ? message : t("errors.navigate")
      )
    },
    [t, failLoad, loadingUrl, committedUrl]
  )
  const { getRect, refreshBounds, owned, contended, takeLease } = useBrowserPaneWebview(
    reservedRef,
    {
      // Only the embedded engine drives the native webview. Handing it the
      // address while another engine is showing would navigate (and could
      // surface) a webview floating over that engine's canvas.
      url: embeddedActive ? committedUrl : null,
      ownerId,
      onReady: handleWebviewReady,
      onError: handleWebviewError,
      onRectChange: handleRectChange,
      visible:
        embeddedActive &&
        !!committedUrl &&
        hasPainted &&
        regionVisible &&
        !loadError &&
        phase !== "timeout" &&
        phase !== "error",
      // The same nonce the web and remote surfaces follow. `committedUrl` alone
      // cannot express "go to A again": React bails out of the identical
      // `setState`, so a pane whose page had drifted to B (an in-page navigation,
      // a redirect) stayed on B while every other backend went back to A.
      navigateNonce: surfaceRequest?.nonce ?? 0,
    }
  )
  const devtools = useBrowserDevtools({ paneId: "browser-embed", enabled: owned })
  const { selection, selections, navigated, selectMode, setSelectMode, clearSelection } =
    useElementSelection({ enabled: owned })
  const { sendScreenshot, sendText } = useSelectionToChat()
  const { driver, lastAction } = useBrowserAgentActivity()
  const toolbarWidth = useElementWidth(toolbarRef)

  useEffect(() => {
    committedUrlRef.current = committedUrl
    setActivePaneRect(committedUrl ? getRect() : null)
  }, [committedUrl, getRect])
  useEffect(() => () => setActivePaneRect(null), [])
  useEffect(() => {
    window.localStorage.setItem(BROWSER_DETAIL_STORAGE_KEY, detailLevel)
  }, [detailLevel])
  useEffect(() => {
    window.localStorage.setItem(BROWSER_ZOOM_STORAGE_KEY, String(zoom))
  }, [zoom])
  // Re-apply zoom whenever the page becomes live (covers webview recreation)
  // or the user changes it. Native zoom persists across in-page navigations.
  useEffect(() => {
    if (owned && committedUrl && hasPainted && regionVisible && webviewReady) {
      void browserClient.embedSetZoom(zoom).catch(() => {})
    }
  }, [owned, committedUrl, hasPainted, regionVisible, webviewReady, zoom])

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
  // A dock page tab remembers where the lightweight preview went.
  const onDockNavigated = dockPage?.onNavigated
  const embeddedUrl = embeddedActive ? currentUrl : null
  useEffect(() => {
    if (embeddedUrl && onDockNavigated) onDockNavigated(embeddedUrl)
  }, [embeddedUrl, onDockNavigated])

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

  const commitAddress = useCallback(
    (next: string) => {
      setUrlInput(next)
      beginLoad(next)
      if (next === committedUrl) {
        // Re-committing the same address still navigates — the page may have
        // moved elsewhere since (in-page navigation, redirect).
        void browserClient
          .embedNavigate(next)
          .catch((error: unknown) => handleWebviewError(error, next))
      } else {
        setCommittedUrl(next)
      }
      urlInputRef.current?.blur()
    },
    [committedUrl, beginLoad, handleWebviewError]
  )

  const commitUrl = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      // ADR-0201: an absolute path or file:// URL is served by Rust's loopback
      // static server — the webview cannot script a file:// origin.
      const localPath = localPathFromAddress(urlInput)
      if (localPath) {
        void serveLocalFile(localPath).then(
          (served) => commitAddress(served.url),
          (error: unknown) =>
            toast.error(
              tLocal("address.localFileFailed", {
                message: error instanceof Error ? error.message : String(error),
              })
            )
        )
        return
      }
      const next = normalizePreviewUrl(urlInput)
      if (!next) {
        toast.error(t("errors.navigate"))
        return
      }
      commitAddress(next)
    },
    [urlInput, t, tLocal, commitAddress]
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

  // The rail's picks live in the page too: clearing one clears both.
  const clearPicks = useCallback(() => {
    clearSelection()
    void browserClient.embedClearSelection().catch(() => {})
  }, [clearSelection])
  // The embedded capture reads the reserved region at send time.
  const railCapture = useCallback(() => ({ captureRect: getRect() ?? undefined }), [getRect])

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
    setLoadingUrl(url)
    setLoadError(null)
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
  useEffect(() => {
    if (docked) return
    return onBrowserUrlRequest((url, request) => {
      // An empty address is `browser_open` without a URL: show the pane on
      // whatever it has open. Anything else must be a navigable address.
      const normalized = url ? normalizePreviewUrl(url) : null
      if (url && !normalized) return false
      if (!regionVisibleRef.current && revealRef.current?.() !== true) return false
      // ADR-0201: a requested engine is honored when it can be served now;
      // an unservable one leaves the pane on the engine it already resolved.
      const wanted = request.backend
      if (wanted && canServeBackendRef.current(wanted)) setBackendPreference(wanted)
      if (normalized) openQuickUrl(normalized)
      return true
    })
  }, [openQuickUrl, docked, setBackendPreference])

  const reloadAfterCookieImport = useCallback(async () => {
    beginLoad()
    await browserClient.embedReload().catch((error: unknown) => {
      handleWebviewError(error)
      throw error
    })
  }, [beginLoad, handleWebviewError])

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
      beginLoad(url)
      setCommittedUrl(url)
    },
    [beginLoad]
  )

  const retryPage = () => {
    const url = loadError?.url ?? loadingUrl ?? committedUrl
    if (!url) return
    beginLoad(url)
    setCommittedUrl(url)
    // Also retries creation if the native webview never became ready.
    setSurfaceRequest((previous) => ({ url, nonce: (previous?.nonce ?? 0) + 1 }))
  }

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
  const backendSwitcher = isTauri() ? (
    <BrowserBackendSwitcher
      decision={backend}
      preference={backendPreference}
      onPreferenceChange={setBackendPreference}
      local={local}
      userChromeBrowser={userChromeBrowser}
      onUserChromeBrowserChange={setUserChromeBrowser}
    />
  ) : undefined

  // A dock page tab switches between Chromium and the lightweight preview from
  // the address bar, where both can serve it.
  const engineChip =
    dockPage &&
    (backend.backend === "local-chromium" ||
      (backend.backend === "embedded" && backend.localReachable)) ? (
      <BrowserEngineChip
        engine={backend.backend}
        onSwitch={(to) =>
          dockPage.onEngineChange(
            to === "embedded"
              ? "embedded"
              : settingsPreference === null || settingsPreference === "local-chromium"
                ? "auto"
                : "local-chromium"
          )
        }
      />
    ) : null

  if (backend.backend === "local-chromium" || backend.backend === "user-chrome") {
    const attached =
      backend.backend === "user-chrome"
        ? ((userChromeCandidate?.browser ?? null) as UserChromeBrowser | null)
        : null
    return (
      <LocalChromiumPreview
        key={`${backend.backend}:${attached ?? ""}`}
        backend={backend.backend}
        userChromeBrowser={attached}
        chatSessionId={effectiveSessionId}
        initialUrl={committedUrl ?? normalizedInitialUrl ?? undefined}
        requestedUrl={surfaceRequest?.url}
        requestNonce={surfaceRequest?.nonce}
        backendSwitcher={backendSwitcher}
        {...(dockPage && backend.backend === "local-chromium"
          ? {
              owner: dockPage.owner,
              pageTag: dockPage.tabId,
              hideTabRow: true,
              toolbarExtras: engineChip,
            }
          : {})}
      />
    )
  }
  if (backend.backend === "remote") {
    return (
      <RemoteBrowserPreview
        chatSessionId={effectiveSessionId ?? "browser-preview"}
        workspaceId={activeProjectId ?? "default"}
        initialUrl={normalizedInitialUrl ?? undefined}
        requestedUrl={surfaceRequest?.url}
        requestNonce={surfaceRequest?.nonce}
        onBackendChange={isTauri() && backend.remoteReachable ? setBackendPreference : undefined}
        {...(backendSwitcher ? { backendSwitcher } : {})}
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
      {engineChip}
      <BrowserZoomControl zoom={zoom} onZoomChange={setZoom} disabled={!nativeReady} />
      <BrowserCookieImportAction
        currentUrl={owned ? currentUrl : null}
        onReload={reloadAfterCookieImport}
      />
      <BrowserDownloadsButton chatSessionId={effectiveSessionId} onRetry={openQuickUrl} />
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
            {backendSwitcher}
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
              beginLoad(target)
              void browserClient
                .embedBack()
                .catch((error: unknown) => handleWebviewError(error, target))
            }}
            onForward={() => {
              const target = historyGoForward()
              if (!target) return
              expectedTraversalRef.current = target
              beginLoad(target)
              void browserClient
                .embedForward()
                .catch((error: unknown) => handleWebviewError(error, target))
            }}
            onReload={() => {
              beginLoad(currentUrl)
              void browserClient
                .embedReload()
                .catch((error: unknown) => handleWebviewError(error, currentUrl ?? undefined))
            }}
            onStop={() => {
              void browserClient.embedStop().catch(() => {})
            }}
          />
        }
      />

      {findOpen && <BrowserFindBarSection onSearch={runFind} onClose={closeFind} />}

      {/* Above the reserved region, never over it: the native webview floats
          above React and would hide anything drawn on top of the page. */}
      {nativeReady && currentUrl && /^https?:/i.test(currentUrl) && (
        <BrowserAutofillPrompt backend="embedded" url={currentUrl} />
      )}

      {/* Below the compact threshold a 320px side rail would leave the page
          nothing to render into, and the native webview floats above React so
          it cannot be overlaid — the rail stacks under the page instead. */}
      <div className={cn("flex min-h-0 flex-1", tier === "compact" && "flex-col")}>
        <div
          ref={reservedRef}
          className="relative min-h-0 min-w-0 flex-1"
          data-testid="browser-reserved-region"
        >
          {contended && (
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
          {!contended &&
            committedUrl &&
            !loadError &&
            phase !== "timeout" &&
            phase !== "error" &&
            !hasPainted && (
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
          {!contended &&
            committedUrl &&
            (loadError || phase === "timeout" || phase === "error") && (
              <div className="absolute inset-0">
                <BrowserLoadError
                  url={loadError?.url ?? loadingUrl ?? committedUrl}
                  message={loadError?.message}
                  timedOut={phase === "timeout" && !loadError}
                  onRetry={retryPage}
                  onEditAddress={() => urlInputRef.current?.focus()}
                  onOpenExternal={() =>
                    void openExternal(loadError?.url ?? loadingUrl ?? committedUrl)
                  }
                  onContinue={phase === "timeout" && !loadError ? revealPage : undefined}
                />
              </div>
            )}
          {!contended && !committedUrl && (
            <BrowserEmptyState onOpen={openQuickUrl} recent={recentHistory} />
          )}
        </div>
        {/* The inspection rail (selection + annotation queue) slides in beside
            the reserved region, or below it when the toolbar is compact. */}
        <BrowserInspectionRail
          selection={selection}
          selections={selections}
          onClearSelection={clearPicks}
          pageUrl={currentUrl}
          sessionId={effectiveSessionId}
          browserSessionId={ownerId ?? `browser:${effectiveSessionId}`}
          capture={railCapture}
          detailLevel={detailLevel}
          placement={tier === "compact" ? "bottom" : "side"}
        />
      </div>

      {/* One collapsed strip for the recorder, the ADR-0127 console / network
          readouts and developer mode — and only once a page is committed, so an
          empty pane spends nothing on it. */}
      {committedUrl && (
        <BrowserToolsDock
          onLayoutChange={refreshBounds}
          openRequest={developerRequest > 0 ? { tab: "developer", nonce: developerRequest } : null}
          recordingSteps={recordingSteps}
          consoleCount={devtools.console.length}
          networkCount={devtools.network.length}
          problemCount={devtools.problemCount}
          failedRequests={devtools.failedRequests}
          recorder={
            <BrowserRecorderPanel
              pageUrl={currentUrl ?? null}
              onRecordingChange={setRecordingSteps}
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
