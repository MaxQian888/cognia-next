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
  pages: BrowserPageSummary[]
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

/** The canvas the screencast is drawn into. */
function useFrameCanvas(): FrameCanvas {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameSizeRef = useRef({ width: 1, height: 1 })
  const drawingRef = useRef(false)
  const drawFrame = useCallback((bytes: Uint8Array) => {
    // Frames arrive faster than a bitmap decodes; drop the ones that land mid-draw.
    if (drawingRef.current) return
    let frame
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      frame = decodeRemoteBrowserFrame(buffer as ArrayBuffer)
    } catch {
      return
    }
    frameSizeRef.current = { width: frame.width, height: frame.height }
    const canvas = canvasRef.current
    if (!canvas || typeof createImageBitmap !== "function") return
    drawingRef.current = true
    const jpeg = new Uint8Array(frame.jpeg.byteLength)
    jpeg.set(frame.jpeg)
    void createImageBitmap(new Blob([jpeg.buffer], { type: "image/jpeg" }))
      .then((bitmap) => {
        canvas.width = frame.width
        canvas.height = frame.height
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, frame.width, frame.height)
        bitmap.close()
      })
      .catch(() => undefined)
      .finally(() => {
        drawingRef.current = false
      })
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
  const toolbarRef = useRef<HTMLDivElement>(null)
  const moveInFlightRef = useRef(false)

  const { engine, sessionId, pages, activePageId, state, refreshPages } = session
  // A file input clicked in the page: the user picks, Rust stages, the page gets the copies.
  useLocalFileChooser(sessionId)
  const activePage =
    pages.find((page) => page.id === activePageId) ?? pages.find((page) => page.active)
  const ready = state === "ready" && !!engine

  const [urlInput, setUrlInput] = useState(initialUrl ?? "")
  const [syncedUrl, setSyncedUrl] = useState<string | null>(null)
  const [editingUrl, setEditingUrl] = useState(false)
  if (activePage?.url && activePage.url !== syncedUrl) {
    setSyncedUrl(activePage.url)
    if (!editingUrl) setUrlInput(activePage.url)
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

  const go = useCallback(
    async (input: string) => {
      if (!engine) return
      const resolved = await resolveBrowserAddress(input, "chromium")
      if (resolved.kind === "invalid") {
        toast.error(browserT("errors.navigate"))
        return
      }
      if (resolved.kind === "error") {
        toast.error(tAddress("localFileFailed", { message: resolved.message }))
        return
      }
      setUrlInput(resolved.url)
      try {
        await engine.navigate(resolved.url)
        await refreshPages()
      } catch (error) {
        fail(error)
      }
    },
    [engine, refreshPages, browserT, tAddress, fail]
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

  const run = (work: () => Promise<unknown> | undefined) => {
    void Promise.resolve(work())
      .then(() => refreshPages())
      .catch(fail)
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

  const sendInput = (input: { kind: "mouse" | "key"; payload: Record<string, unknown> }) => {
    if (!sessionId) return Promise.resolve()
    return localBrowser.rpc("browser.input", { sessionId, input }).catch(() => undefined)
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
    void sendInput({
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
          onUrlChange={setUrlInput}
          onSubmit={submit}
          onUrlFocus={() => setEditingUrl(true)}
          onUrlBlur={() => setEditingUrl(false)}
          addressDisplay={
            urlInput === (activePage?.url ?? "") ? addressDisplayParts(urlInput) : null
          }
          collapsedActive={findOpen || zoom !== 1}
          overflowExtras={backendSwitcher}
          navigation={
            <BrowserNavigationControls
              disabled={!ready}
              backDisabled={!canGoBack}
              forwardDisabled={!canGoForward}
              onBack={() => {
                if (!historyGoBack()) return
                run(() => engine?.back())
              }}
              onForward={() => {
                if (!historyGoForward()) return
                run(() => engine?.forward())
              }}
              onReload={() => run(() => engine?.reload())}
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
                zoom={zoom}
                onZoomChange={(next) => {
                  setZoom(next)
                  void engine?.setZoom(next).catch(() => undefined)
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
                disabled={!activePage?.url}
                onClick={() => {
                  if (activePage?.url) void openExternal(activePage.url)
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
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              role="application"
              aria-label={t("canvas")}
              className="h-full w-full object-contain outline-none"
              onPointerMove={(event) => {
                if (!ready || moveInFlightRef.current) return
                moveInFlightRef.current = true
                void sendInput({
                  kind: "mouse",
                  payload: { type: "mouseMoved", ...pointerPayload(event) },
                }).finally(() => {
                  moveInFlightRef.current = false
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
                void sendInput({
                  kind: "mouse",
                  payload: { type: "mousePressed", ...pointerPayload(event) },
                })
              }}
              onPointerUp={(event) => {
                if (!ready) return
                void sendInput({
                  kind: "mouse",
                  payload: { type: "mouseReleased", ...pointerPayload(event) },
                })
              }}
              onWheel={(event) => {
                if (!ready) return
                void sendInput({
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
            {(state === "failed" || state === "closed") && (
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
