"use client"

/**
 * The browser pane body for the desktop's local runtime (ADR-0201): Cognia's
 * own Chromium (`local-chromium`) or the user's Chrome attached over its
 * consent-gated remote debugging (`user-chrome`).
 *
 * The page is a screencast drawn into a canvas — the same 24-byte framed JPEG
 * and `decodeRemoteBrowserFrame` the cloud browser uses — and the user's mouse
 * and keyboard go back as native input (`browser.input`). Unlike the cloud
 * stream there is no control lease: the runtime is on this machine and only
 * this pane draws it, so the user always has the controls.
 *
 * Tabs, downloads, native dialogs, file choosers (answered with files the
 * user picks and Rust stages under the upload root), extensions, cookie
 * import and the password vault's autofill / save prompts all hang off the
 * runtime session behind the pane:
 *
 * - Cognia's own Chromium is ONE session shared by every pane and agent
 *   (`useSharedLocalBrowser`, ADR-0214). The pane shows its owner's pages — a
 *   dock page tab's one page (`pageTag`, tab row hidden: the dock's strip is
 *   the tab row), or a pane's own pages with its own tab row.
 * - The user's own Chrome is a session of the pane's own
 *   (`useLocalBrowserSession`), closed with the pane.
 */

import {
  CameraIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MonitorXIcon,
  MousePointerSquareDashedIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import { resolveBrowserAddress } from "@/components/browser/browser-address"
import {
  BrowserConsolePanel,
  BrowserNetworkPanel,
} from "@/components/browser/browser-devtools-panels"
import { BrowserDownloadsButton } from "@/components/browser/browser-downloads-panel"
import { BrowserEmptyState } from "@/components/browser/browser-empty-state"
import { BrowserLoadError } from "@/components/browser/browser-load-error"
import { BrowserFindBarSection, isFindShortcut } from "@/components/browser/browser-find-bar"
import { BrowserHistoryMenu } from "@/components/browser/browser-history-menu"
import { BrowserNavigationControls } from "@/components/browser/browser-navigation-controls"
import {
  BrowserToolbar,
  addressDisplayParts,
  toolbarTier,
} from "@/components/browser/browser-toolbar"
import { BrowserToolsDock } from "@/components/browser/browser-tools-dock"
import { BrowserZoomControl } from "@/components/browser/browser-zoom-control"
import { BrowserCookieImportAction } from "@/components/browser/browser-cookie-import-action"
import { BrowserInspectionRail } from "@/components/browser/browser-inspection-rail"
import { BrowserExtensionsPanel } from "@/components/browser/extensions/browser-extensions-panel"
import { LocalBrowserDialog } from "@/components/browser/local-browser-dialog"
import { EngineRecorder } from "@/components/browser/remote-browser-preview"
import { BrowserAutofillPrompt } from "@/components/browser/vault/browser-autofill-prompt"
import { BrowserSavePasswordPrompt } from "@/components/browser/vault/browser-save-password-prompt"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useBrowserDevtools } from "@/hooks/browser/use-browser-devtools"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useElementSelection } from "@/hooks/browser/use-element-selection"
import { useElementWidth } from "@/hooks/use-element-width"
import {
  useLocalBrowserSession,
  type LocalSessionState,
} from "@/hooks/browser/use-local-browser-session"
import { useSharedLocalBrowser } from "@/hooks/browser/use-shared-local-browser"
import { useLocalFileChooser } from "@/hooks/browser/use-local-file-chooser"
import { useRecentPages } from "@/hooks/browser/use-recent-pages"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { localBrowser, type UserChromeBrowser } from "@/lib/browser/local-client"
import type { LocalChromiumEngine, LocalEngineBackend } from "@/lib/browser/local-chromium-engine"
import type { BrowserPageSummary } from "@/lib/browser/session-types"
import type { LocalBrowserDialog as LocalBrowserDialogState } from "@/lib/browser/shared-local-browser"
import { createFramePainter, type FramePainter } from "@/lib/browser/frame-painter"
import {
  createLocalInputQueue,
  type LocalBrowserInput,
  type LocalInputQueue,
} from "@/lib/browser/local-input-queue"
import { canvasPointToFrame, decodeRemoteBrowserFrame } from "@/lib/browser/remote-stream"
import type { BrowserAdjustDriver } from "@/lib/browser/adjust"
import { BROWSER_DETAIL_STORAGE_KEY } from "@/lib/browser/preview-data"
import type { OutputDetailLevel } from "@/lib/browser/protocol"
import { localSelectionSource } from "@/lib/browser/selection-source"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"

const DEVTOOLS_POLL_MS = 1_500
const DEVTOOLS_IDLE_POLL_MS = 6_000

function mouseButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle"
  if (button === 2) return "right"
  return "left"
}

export interface LocalChromiumPreviewProps {
  backend: LocalEngineBackend
  /** Which of the user's browsers to attach (`user-chrome`). */
  userChromeBrowser?: UserChromeBrowser | null
  /** The chat that screenshots, comments and attached downloads go to. */
  chatSessionId?: string
  initialUrl?: string
  /** A host-stated address to go to now; see `BrowserPreviewPane`. */
  requestedUrl?: string
  requestNonce?: number
  /** The engine switch, drawn in the toolbar's overflow popover. */
  backendSwitcher?: ReactNode
  /**
   * Whose pages the pane shows in the shared Chromium session (`chat:<id>` for
   * the dock). Absent: the pane's own, closed when it unmounts.
   */
  owner?: string
  /** Show only the owner's page behind this tag — a dock page tab. */
  pageTag?: string
  /** Leave the tab row out: the dock's strip already lists the pages. */
  hideTabRow?: boolean
  /** Drawn first among the toolbar's page actions (the dock's engine chip). */
  toolbarExtras?: ReactNode
}

/** What the pane body needs from whichever session is behind it. */
interface PaneSession {
  state: LocalSessionState
  error: string | null
  sessionId: string | null
  engine: LocalChromiumEngine | null
  pages: (BrowserPageSummary & { zoom?: number; fitToWidth?: boolean })[]
  activePageId: string | null
  dialog: LocalBrowserDialogState | null
  answerDialog: (answer: { accept: boolean; promptText?: string }) => Promise<void>
  refreshPages: () => Promise<void>
  restart: () => void
  restoring: boolean
  selectPage: (pageId: string) => Promise<void> | void
  createPage: () => Promise<void>
  closePage: (pageId: string) => Promise<void>
}

interface FrameCanvas {
  canvasRef: RefObject<HTMLCanvasElement | null>
  frameSizeRef: RefObject<{ width: number; height: number }>
  drawFrame: (bytes: Uint8Array) => void
}

const DETAIL_LEVELS: readonly OutputDetailLevel[] = ["compact", "standard", "detailed", "forensic"]

/** The comment detail level the lightweight preview's selector last stored. */
function storedDetailLevel(): OutputDetailLevel {
  if (typeof window === "undefined") return "standard"
  const stored = window.localStorage.getItem(BROWSER_DETAIL_STORAGE_KEY)
  return DETAIL_LEVELS.includes(stored as OutputDetailLevel)
    ? (stored as OutputDetailLevel)
    : "standard"
}

/** The canvas the screencast is drawn into (`createFramePainter`). */
function useFrameCanvas(): FrameCanvas {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameSizeRef = useRef({ width: 1, height: 1 })
  // Made on the first frame and dropped on unmount (a remount makes another).
  const painterRef = useRef<FramePainter | null>(null)
  useEffect(
    () => () => {
      painterRef.current?.dispose()
      painterRef.current = null
    },
    []
  )
  const drawFrame = useCallback((bytes: Uint8Array) => {
    let frame
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      frame = decodeRemoteBrowserFrame(buffer as ArrayBuffer)
    } catch {
      return
    }
    // The header describes CSS input coordinates; the bitmap carries the
    // Retina pixels Chromium rendered at its launch density.
    frameSizeRef.current = { width: frame.width, height: frame.height }
    painterRef.current ??= createFramePainter(() => canvasRef.current)
    painterRef.current.paint(frame)
  }, [])
  return { canvasRef, frameSizeRef, drawFrame }
}

export function LocalChromiumPreview(props: LocalChromiumPreviewProps) {
  return props.backend === "user-chrome" ? (
    <UserChromePreview {...props} />
  ) : (
    <SharedChromiumPreview {...props} />
  )
}

/** Cognia's own Chromium: pages of the one shared session. */
function SharedChromiumPreview(props: LocalChromiumPreviewProps) {
  const canvas = useFrameCanvas()
  const paneId = useId()
  const session = useSharedLocalBrowser({
    owner: props.owner ?? `pane:${paneId}`,
    tag: props.pageTag,
    initialUrl: props.initialUrl,
    onFrame: canvas.drawFrame,
  })
  return <LocalPreviewBody {...props} session={session} canvas={canvas} />
}

/** The user's own Chrome: a session of this pane's own. */
function UserChromePreview(props: LocalChromiumPreviewProps) {
  const canvas = useFrameCanvas()
  const session = useLocalBrowserSession({
    backend: props.backend,
    userChromeBrowser: props.userChromeBrowser,
    initialUrl: props.initialUrl,
    onFrame: canvas.drawFrame,
  })
  const { engine, refreshPages, dismissDialog } = session
  const pane = useMemo<PaneSession>(
    () => ({
      ...session,
      restoring: false,
      answerDialog: async (answer) => {
        dismissDialog()
        await engine?.handleDialog(answer)
      },
      selectPage: async (pageId) => {
        await engine?.activatePage(pageId)
        await refreshPages()
      },
      createPage: async () => {
        await engine?.createPage()
        await refreshPages()
      },
      closePage: async (pageId) => {
        await engine?.closePage(pageId)
        await refreshPages()
      },
    }),
    [session, engine, refreshPages, dismissDialog]
  )
  return <LocalPreviewBody {...props} session={pane} canvas={canvas} />
}

function LocalPreviewBody({
  backend,
  chatSessionId,
  initialUrl,
  requestedUrl,
  requestNonce,
  backendSwitcher,
  hideTabRow = false,
  toolbarExtras,
  session,
  canvas,
}: LocalChromiumPreviewProps & { session: PaneSession; canvas: FrameCanvas }) {
  const t = useTranslations("browserLocal.pane")
  const tExt = useTranslations("browserLocal.extensions")
  const tAddress = useTranslations("browserLocal.address")
  const browserT = useTranslations("browser")
  const actionsT = useTranslations("browser.actions")
  const screenshotT = useTranslations("browser.screenshot")
  const dialogT = useTranslations("browserLocal.dialog")

  const { canvasRef, frameSizeRef } = canvas
  const viewportRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const navigationAttemptRef = useRef(0)
  const resizeQueueRef = useRef<Promise<void>>(Promise.resolve())

  const { engine, sessionId, pages, activePageId, state, refreshPages } = session
  // The user's input goes out in order, coalesced while one event is in
  // flight: one queue per runtime session, made on the first event.
  const inputQueueRef = useRef<{ sessionId: string; queue: LocalInputQueue } | null>(null)
  useEffect(
    () => () => {
      inputQueueRef.current?.queue.dispose()
      inputQueueRef.current = null
    },
    []
  )
  // A file input clicked in the page: the user picks, Rust stages, the page gets the copies.
  useLocalFileChooser(sessionId)
  const activePage =
    pages.find((page) => page.id === activePageId) ?? pages.find((page) => page.active)
  const fitToWidth = activePage?.fitToWidth !== false
  const ready = state === "ready" && !!engine
  const [navigationFailure, setNavigationFailure] = useState<{
    url: string
    pageId: string | null
  } | null>(null)
  const pageFailure = navigationFailure?.pageId === activePageId ? navigationFailure : null
  // Use the same destination as the error screen, including when an older
  // runtime reports Chromium's internal error document as the active URL.
  const pageUrl =
    pageFailure?.url ?? (state === "failed" && engine ? initialUrl : undefined) ?? activePage?.url

  const [urlInput, setUrlInput] = useState(initialUrl ?? "")
  const [syncedUrl, setSyncedUrl] = useState<string | null>(null)
  const [editingUrl, setEditingUrl] = useState(false)
  if (pageUrl && !pageUrl.startsWith("chrome-error:") && pageUrl !== syncedUrl) {
    setSyncedUrl(pageUrl)
    if (!editingUrl) setUrlInput(pageUrl)
  }

  const [zoom, setZoom] = useState(1)
  const [findOpen, setFindOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [recordingSteps, setRecordingSteps] = useState<number | null>(null)
  const [clickPointer, setClickPointer] = useState<{ x: number; y: number; key: number } | null>(
    null
  )
  const {
    push: pushHistory,
    goBack: historyGoBack,
    goForward: historyGoForward,
    canGoBack,
    canGoForward,
    // Per page, so a page's back stack survives the dock switching tabs.
  } = useBrowserHistory(
    sessionId && activePageId ? `local:${sessionId}:${activePageId}` : undefined
  )
  const { recent: recentHistory, clear: clearRecentPages } = useRecentPages()
  const { sendScreenshotBytes, sendText } = useSelectionToChat()

  // Element pick, annotations and Browser Adjust on the page in front (ADR-0214):
  // the same overlay as the lightweight preview, reached through runtime ops.
  const shownPageId = activePage?.id ?? null
  const panelDetails = browserT("panel.details")
  const panelCollapse = browserT("panel.collapse")
  const selectionSource = useMemo(
    () =>
      engine && shownPageId
        ? localSelectionSource(engine, shownPageId, {
            details: panelDetails,
            collapse: panelCollapse,
          })
        : undefined,
    [engine, shownPageId, panelDetails, panelCollapse]
  )
  const { selection, selections, selectMode, setSelectMode, clearSelection } = useElementSelection({
    source: selectionSource,
    enabled: ready && !!selectionSource,
  })
  const adjustDriver = useMemo<BrowserAdjustDriver | undefined>(
    () => (engine ? { run: (action, input) => engine.adjust(action, input) } : undefined),
    [engine]
  )
  const clearPicks = useCallback(() => {
    clearSelection()
    void selectionSource?.clear().catch(() => undefined)
  }, [clearSelection, selectionSource])
  const railCapture = useCallback(
    () => ({ capture: async () => (engine ? engine.screenshot() : null) }),
    [engine]
  )
  const [detailLevel] = useState(storedDetailLevel)
  const toolbarWidth = useElementWidth(toolbarRef)
  const railPlacement = toolbarTier(toolbarWidth) === "compact" ? "bottom" : "side"
  const devtools = useBrowserDevtools({
    poll: useMemo(
      () =>
        engine
          ? {
              readConsole: () => engine.readConsole(),
              readNetwork: () => engine.readNetwork(),
              intervalMs: toolsExpanded ? DEVTOOLS_POLL_MS : DEVTOOLS_IDLE_POLL_MS,
            }
          : null,
      [engine, toolsExpanded]
    ),
  })

  // Every page the active tab lands on goes into the visit history.
  const activeUrl = activePage?.url
  useEffect(() => {
    if (activeUrl && /^https?:/i.test(activeUrl)) pushHistory(activeUrl)
  }, [activeUrl, pushHistory])

  const fail = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(browserT("remote.error", { code: message }))
    },
    [browserT]
  )

  // Resize the page itself, rather than letterboxing a fixed desktop viewport.
  // Measure the available box, independently of the frame's intrinsic size.
  useEffect(() => {
    const element = viewportRef.current
    if (!ready || session.dialog || !sessionId || !shownPageId || !element) return
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    type Viewport = {
      width: number
      height: number
      deviceScaleFactor: number
      fitToWidth: boolean
    }
    let desired: Viewport | null = null
    let applied: Viewport | null = null

    const flush = async () => {
      if (disposed || inFlight || !desired) return
      const viewport = desired
      if (
        applied?.width === viewport.width &&
        applied.height === viewport.height &&
        applied.deviceScaleFactor === viewport.deviceScaleFactor
      )
        return
      inFlight = true
      try {
        // Keep the queue across tab changes: switching away and back must not
        // let an older request finish after the new tab's current dimensions.
        const resize = resizeQueueRef.current.then(async () => {
          if (!disposed) {
            await localBrowser.rpc("browser.emulate", { sessionId, pageId: shownPageId, viewport })
          }
        })
        resizeQueueRef.current = resize.catch(() => undefined)
        await resize
        applied = viewport
      } catch (error) {
        if (!disposed) fail(error)
      } finally {
        inFlight = false
        // A drag may have changed size while the runtime was still resizing.
        // Only the latest pending measurement is sent after that call settles.
        if (!disposed && desired && desired !== viewport) void flush()
      }
    }
    const measure = () => {
      clearTimeout(timer)
      const { clientWidth: width, clientHeight: height } = element
      if (width <= 0 || height <= 0) {
        desired = null
        return
      }
      const next = {
        width: Math.max(1, Math.min(8192, Math.round(width))),
        height: Math.max(1, Math.min(8192, Math.round(height))),
        deviceScaleFactor: Math.max(0.5, Math.min(4, window.devicePixelRatio || 1)),
        fitToWidth,
      }
      if (
        desired?.width !== next.width ||
        desired.height !== next.height ||
        desired.deviceScaleFactor !== next.deviceScaleFactor
      )
        desired = next
      timer = setTimeout(() => void flush(), 100)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // Moving the window to another display can change density without size.
    let densityQuery: MediaQueryList
    const watchDensity = () => {
      densityQuery?.removeEventListener("change", densityChanged)
      densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      densityQuery.addEventListener("change", densityChanged)
    }
    const densityChanged = () => {
      measure()
      watchDensity()
    }
    watchDensity()
    window.addEventListener("resize", measure)
    measure()
    return () => {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      densityQuery.removeEventListener("change", densityChanged)
      window.removeEventListener("resize", measure)
    }
  }, [ready, sessionId, shownPageId, session.dialog, fitToWidth, fail])

  const go = useCallback(
    async (input: string) => {
      if (!engine) return
      const attempt = ++navigationAttemptRef.current
      const resolved = await resolveBrowserAddress(input, "chromium")
      if (attempt !== navigationAttemptRef.current) return
      if (resolved.kind === "invalid") {
        toast.error(browserT("errors.navigate"))
        return
      }
      if (resolved.kind === "error") {
        toast.error(tAddress("localFileFailed", { message: resolved.message }))
        return
      }
      setNavigationFailure(null)
      setUrlInput(resolved.url)
      try {
        await engine.navigate(resolved.url)
        if (attempt !== navigationAttemptRef.current) return
        await refreshPages()
      } catch (error) {
        if (attempt === navigationAttemptRef.current) {
          setNavigationFailure({ url: resolved.url, pageId: activePageId })
          fail(error)
        }
      }
    },
    [engine, refreshPages, browserT, tAddress, fail, activePageId]
  )

  // A host-stated address (a link clicked in the conversation), applied once
  // an engine exists, keyed by request so the same address twice is two visits.
  const requestKey = requestedUrl ? `${requestNonce ?? 0}:${requestedUrl}` : null
  const deliveredKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!requestKey || !requestedUrl || !engine || state !== "ready") return
    if (deliveredKeyRef.current === requestKey) return
    // The initial address is navigated by the session itself.
    if (deliveredKeyRef.current === null && requestedUrl === initialUrl) {
      deliveredKeyRef.current = requestKey
      return
    }
    deliveredKeyRef.current = requestKey
    void go(requestedUrl)
  }, [requestKey, requestedUrl, engine, state, initialUrl, go])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!urlInput.trim()) return
    void go(urlInput)
  }

  const run = (work: () => Promise<unknown> | undefined, navigationUrl?: string) => {
    const attempt = navigationUrl ? ++navigationAttemptRef.current : null
    if (navigationUrl) setNavigationFailure(null)
    void Promise.resolve(work())
      .then(() => refreshPages())
      .catch((error: unknown) => {
        if (navigationUrl && attempt === navigationAttemptRef.current) {
          setNavigationFailure({ url: navigationUrl, pageId: activePageId })
        }
        fail(error)
      })
  }

  const captureToChat = async () => {
    if (!engine) return
    setCapturing(true)
    try {
      const shot = await engine.screenshot()
      const sent = await sendScreenshotBytes(shot.bytes, {
        sessionId: chatSessionId,
        pageUrl: activePage?.url,
      })
      if (sent) toast.success(screenshotT("sent"))
      else toast.error(screenshotT("failed"))
    } catch {
      toast.error(screenshotT("failed"))
    } finally {
      setCapturing(false)
    }
  }

  const sendInput = (input: LocalBrowserInput) => {
    if (!sessionId) return
    let entry = inputQueueRef.current
    if (entry?.sessionId !== sessionId) {
      entry?.queue.dispose()
      const target = sessionId
      entry = {
        sessionId: target,
        queue: createLocalInputQueue((queued) =>
          localBrowser.rpc("browser.input", { sessionId: target, input: queued })
        ),
      }
      inputQueueRef.current = entry
    }
    entry.queue.send(input)
  }

  const pointerPayload = (event: PointerEvent<HTMLCanvasElement>) => ({
    ...canvasPointToFrame(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      frameSizeRef.current
    ),
    button: mouseButton(event.button),
    clickCount: 1,
  })

  const sendKey = (event: KeyboardEvent<HTMLCanvasElement>, type: "keyDown" | "keyUp") => {
    if (!ready) return
    event.preventDefault()
    sendInput({
      kind: "key",
      payload: {
        type,
        key: event.key,
        code: event.code,
        modifiers:
          (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0),
        ...(type === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
      },
    })
  }

  const answerDialog = async (answer: { accept: boolean; promptText?: string }) => {
    try {
      await session.answerDialog(answer)
    } catch {
      toast.error(dialogT("failed"))
    }
  }

  const showEmpty = ready && (!activePage?.url || activePage.url === "about:blank") && !initialUrl

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col" data-testid="local-chromium-preview">
        <BrowserToolbar
          toolbarRef={toolbarRef}
          loading={state === "starting"}
          url={urlInput}
          urlInputRef={urlInputRef}
          onUrlChange={setUrlInput}
          onSubmit={submit}
          onUrlFocus={() => setEditingUrl(true)}
          onUrlBlur={() => setEditingUrl(false)}
          addressDisplay={urlInput === (pageUrl ?? "") ? addressDisplayParts(urlInput) : null}
          collapsedActive={findOpen || (activePage?.zoom ?? zoom) !== 1}
          overflowExtras={backendSwitcher}
          navigation={
            <BrowserNavigationControls
              disabled={!ready}
              backDisabled={!canGoBack}
              forwardDisabled={!canGoForward}
              onBack={() => {
                const url = historyGoBack()
                if (url) run(() => engine?.back(), url)
              }}
              onForward={() => {
                const url = historyGoForward()
                if (url) run(() => engine?.forward(), url)
              }}
              onReload={() =>
                pageFailure
                  ? void go(pageFailure.url)
                  : run(() => engine?.reload(), activePage?.url)
              }
            />
          }
          inspectActions={
            <>
              <BrowserHistoryMenu
                recent={recentHistory}
                onNavigate={(url) => void go(url)}
                onClear={() => {
                  void clearRecentPages().then((cleared) => {
                    if (!cleared) toast.error(browserT("history.clearFailed"))
                  })
                }}
                disabled={recentHistory.length === 0}
              />
              <TooltipIconButton
                tooltip={selectMode ? actionsT("cancelSelect") : actionsT("selectElement")}
                aria-label={selectMode ? actionsT("cancelSelect") : actionsT("selectElement")}
                disabled={!ready || !selectionSource}
                className={cn(selectMode && "bg-primary/15 text-primary")}
                onClick={() => void setSelectMode(!selectMode).catch(fail)}
              >
                <MousePointerSquareDashedIcon />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={actionsT("screenshot")}
                aria-label={actionsT("screenshot")}
                disabled={!ready || capturing}
                onClick={() => void captureToChat()}
              >
                {capturing ? <Loader2Icon className="animate-spin" /> : <CameraIcon />}
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={actionsT("find")}
                aria-label={actionsT("find")}
                disabled={!ready}
                className={cn(findOpen && "bg-primary/15 text-primary")}
                onClick={() => {
                  if (findOpen) {
                    setFindOpen(false)
                    void engine?.findClear().catch(() => undefined)
                  } else {
                    setFindOpen(true)
                  }
                }}
              >
                <SearchIcon />
              </TooltipIconButton>
            </>
          }
          pageActions={
            <>
              {toolbarExtras}
              <BrowserZoomControl
                zoom={activePage?.zoom ?? zoom}
                onZoomChange={(next) => {
                  setZoom(next)
                  void engine?.setZoom(next).then(refreshPages).catch(fail)
                }}
                disabled={!ready}
              />
              <BrowserCookieImportAction
                backend={backend}
                sessionId={sessionId ?? undefined}
                currentUrl={ready ? (activePage?.url ?? null) : null}
                onReload={async () => {
                  await engine?.reload()
                }}
              />
              {backend === "local-chromium" && (
                <Popover>
                  <PopoverTrigger asChild>
                    <TooltipIconButton
                      tooltip={tExt("button")}
                      aria-label={tExt("button")}
                      disabled={!ready}
                    >
                      <PuzzleIcon />
                    </TooltipIconButton>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-96 p-0">
                    <BrowserExtensionsPanel backend={backend} sessionId={sessionId ?? undefined} />
                  </PopoverContent>
                </Popover>
              )}
              <TooltipIconButton
                tooltip={actionsT("openExternal")}
                aria-label={actionsT("openExternal")}
                disabled={!pageUrl || pageUrl.startsWith("chrome-error:")}
                onClick={() => {
                  if (pageUrl) void openExternal(pageUrl)
                }}
              >
                <ExternalLinkIcon />
              </TooltipIconButton>
            </>
          }
          trailing={
            <BrowserDownloadsButton chatSessionId={chatSessionId} onRetry={(url) => void go(url)} />
          }
        />

        {findOpen && engine && (
          <BrowserFindBarSection
            onSearch={(query, options) => engine.find(query, options)}
            onClose={() => {
              setFindOpen(false)
              void engine.findClear().catch(() => undefined)
            }}
          />
        )}

        {hideTabRow ? null : (
          <div
            className="flex items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2 py-1"
            role="tablist"
            aria-label={t("tabs")}
          >
            {pages.map((page) => (
              <div
                key={page.id}
                className={cn(
                  "flex min-w-28 max-w-52 items-center rounded-md border",
                  page.id === activePageId ? "bg-background" : "bg-muted/40"
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={page.id === activePageId}
                  className="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs"
                  title={page.url}
                  onClick={() => run(async () => session.selectPage(page.id))}
                >
                  {page.title || page.url || t("untitled")}
                </button>
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-foreground"
                  aria-label={t("closeTab")}
                  onClick={() => run(() => session.closePage(page.id))}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
            <TooltipIconButton
              tooltip={t("newTab")}
              aria-label={t("newTab")}
              size="icon-xs"
              disabled={!ready}
              onClick={() => run(() => session.createPage())}
            >
              <PlusIcon />
            </TooltipIconButton>
          </div>
        )}

        {ready && activePage?.url && /^https?:/i.test(activePage.url) && (
          <BrowserAutofillPrompt
            backend={backend}
            sessionId={sessionId ?? undefined}
            pageId={activePage.id}
            url={activePage.url}
          />
        )}
        {sessionId && <BrowserSavePasswordPrompt sessionId={sessionId} />}

        <div className={cn("flex min-h-0 flex-1", railPlacement === "bottom" && "flex-col")}>
          <div
            ref={viewportRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black"
          >
            <canvas
              ref={canvasRef}
              tabIndex={0}
              role="application"
              aria-label={t("canvas")}
              className="absolute inset-0 h-full w-full object-contain outline-none"
              onPointerMove={(event) => {
                if (!ready) return
                sendInput({
                  kind: "mouse",
                  payload: { type: "mouseMoved", ...pointerPayload(event) },
                })
              }}
              onPointerDown={(event) => {
                event.currentTarget.focus()
                if (!ready) return
                const rect = event.currentTarget.getBoundingClientRect()
                const x = rect.width ? ((event.clientX - rect.left) / rect.width) * 100 : 0
                const y = rect.height ? ((event.clientY - rect.top) / rect.height) * 100 : 0
                setClickPointer((previous) => ({
                  x: Math.max(0, Math.min(100, x)),
                  y: Math.max(0, Math.min(100, y)),
                  key: (previous?.key ?? 0) + 1,
                }))
                sendInput({
                  kind: "mouse",
                  payload: { type: "mousePressed", ...pointerPayload(event) },
                })
              }}
              onPointerUp={(event) => {
                if (!ready) return
                sendInput({
                  kind: "mouse",
                  payload: { type: "mouseReleased", ...pointerPayload(event) },
                })
              }}
              onWheel={(event) => {
                if (!ready) return
                sendInput({
                  kind: "mouse",
                  payload: {
                    type: "mouseWheel",
                    ...pointerPayload(event as unknown as PointerEvent<HTMLCanvasElement>),
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                  },
                })
              }}
              onKeyDown={(event) => {
                if (isFindShortcut(event)) {
                  event.preventDefault()
                  setFindOpen(true)
                  return
                }
                sendKey(event, "keyDown")
              }}
              onKeyUp={(event) => sendKey(event, "keyUp")}
            />
            {clickPointer && (
              <span
                key={clickPointer.key}
                className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-primary bg-primary/20"
                style={{ left: `${clickPointer.x}%`, top: `${clickPointer.y}%` }}
                aria-hidden
              />
            )}
            {showEmpty && (
              <div className="absolute inset-0 bg-background">
                <BrowserEmptyState onOpen={(url) => void go(url)} recent={recentHistory} />
              </div>
            )}
            {(ready || state === "failed") && pageFailure && (
              <div className="absolute inset-0">
                <BrowserLoadError
                  url={pageFailure.url}
                  onRetry={() => void go(pageFailure.url)}
                  onEditAddress={() => urlInputRef.current?.focus()}
                  onOpenExternal={
                    /^https?:/i.test(pageFailure.url)
                      ? () => void openExternal(pageFailure.url)
                      : undefined
                  }
                />
              </div>
            )}
            {state === "starting" && (
              <div
                className="absolute inset-0 flex items-center justify-center gap-2 bg-background/80 p-6 text-center"
                role="status"
                aria-live="polite"
              >
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {session.restoring ? t("restoring") : t("starting")}
                </p>
              </div>
            )}
            {!pageFailure && state === "failed" && engine && initialUrl ? (
              <div className="absolute inset-0">
                <BrowserLoadError
                  url={initialUrl}
                  onRetry={session.restart}
                  onEditAddress={() => urlInputRef.current?.focus()}
                  onOpenExternal={
                    /^https?:/i.test(initialUrl) ? () => void openExternal(initialUrl) : undefined
                  }
                />
              </div>
            ) : (
              ((state === "failed" && !pageFailure) || state === "closed") && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center"
                  role="alert"
                >
                  <MonitorXIcon className="size-6 text-muted-foreground" />
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {state === "failed"
                      ? t("failed", { code: session.error ?? "browser_local_unavailable" })
                      : t("closed")}
                  </p>
                  <Button size="sm" variant="outline" onClick={session.restart}>
                    {t("restart")}
                  </Button>
                  {backendSwitcher && <div className="w-64 text-left">{backendSwitcher}</div>}
                </div>
              )
            )}
          </div>
          <BrowserInspectionRail
            selection={selection}
            selections={selections}
            onClearSelection={clearPicks}
            pageUrl={activePage?.url ?? null}
            sessionId={chatSessionId}
            browserSessionId={sessionId ? `local:${sessionId}` : `browser:${chatSessionId ?? ""}`}
            capture={railCapture}
            detailLevel={detailLevel}
            {...(adjustDriver ? { adjustDriver } : {})}
            placement={railPlacement}
          />
        </div>

        {engine && (
          <BrowserToolsDock
            recordingSteps={recordingSteps}
            onExpandedChange={setToolsExpanded}
            consoleCount={devtools.console.length}
            networkCount={devtools.network.length}
            problemCount={devtools.problemCount}
            failedRequests={devtools.failedRequests}
            recorder={
              <EngineRecorder
                engine={engine}
                pageUrl={activePage?.url ?? null}
                onSendToChat={(markdown) => void sendText(markdown, { sessionId: chatSessionId })}
                onRecordingChange={setRecordingSteps}
              />
            }
            console={
              <BrowserConsolePanel entries={devtools.console} onClear={devtools.clearConsole} />
            }
            network={
              <BrowserNetworkPanel entries={devtools.network} onClear={devtools.clearNetwork} />
            }
          />
        )}

        <LocalBrowserDialog
          dialog={session.dialog}
          onAnswer={(answer) => void answerDialog(answer)}
        />
      </div>
    </TooltipProvider>
  )
}
