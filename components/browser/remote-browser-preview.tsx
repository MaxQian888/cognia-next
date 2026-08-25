"use client"

import {
  CameraIcon,
  CloudOffIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MonitorUpIcon,
  MousePointerSquareDashedIcon,
  SearchIcon,
  SendIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useMemo,
  useEffect,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import { BrowserFindBarSection, isFindShortcut } from "@/components/browser/browser-find-bar"
import { BrowserHistoryMenu } from "@/components/browser/browser-history-menu"
import { BrowserNavigationControls } from "@/components/browser/browser-navigation-controls"
import { BrowserCookieImportAction } from "@/components/browser/browser-cookie-import-action"
import { BrowserToolbar, addressDisplayParts } from "@/components/browser/browser-toolbar"
import {
  BrowserConsolePanel,
  BrowserNetworkPanel,
} from "@/components/browser/browser-devtools-panels"
import { BrowserToolsDock } from "@/components/browser/browser-tools-dock"
import { useBrowserDevtools } from "@/hooks/browser/use-browser-devtools"
import { BrowserRecorderPanel } from "@/components/browser/browser-recorder-panel"
import { BrowserZoomControl } from "@/components/browser/browser-zoom-control"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useFlowRecorder } from "@/hooks/browser/use-flow-recorder"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { configureRemoteBrowserEngine } from "@/lib/browser/agent-engine"
import { RemoteChromiumEngine } from "@/lib/browser/remote-chromium-engine"
import { createEngineRecordingDriver } from "@/lib/browser/recording/engine-recording-driver"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { cn } from "@/lib/utils"
import {
  listBrowserDomainGrants,
  listBrowserProfiles,
  touchBrowserProfile,
} from "@/lib/db/browser-profiles"
import {
  RemoteBrowserStream,
  type RemoteBrowserConnectionState,
  type RemoteBrowserFrame,
  type RemoteBrowserLease,
  type RemoteBrowserStreamOptions,
} from "@/lib/browser/remote-stream"
import type { BrowserPageSummary } from "@/lib/browser/session-types"
import type { BrowserSelection, SnapshotNode } from "@/lib/browser/protocol"
import { buildTimeServerUrl } from "@/lib/platform/web-companion"
import { openExternal } from "@/lib/tauri/opener"
import { issueCompanionSocketTicket } from "@/lib/tauri/transport-companion"
import { issueSocketTicket } from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import {
  defaultCompanionEndpointResolver,
  type CompanionEndpoint,
} from "@/lib/tauri/companion-endpoint"
import { transport } from "@/lib/tauri/transport-instance"

interface RemoteSessionRpcSummary {
  id: string
  state: string
  pages: BrowserPageSummary[]
  activePageId: string | null
}

interface StreamLike {
  connect(): Promise<void>
  close(): void
  takeover(): void
  sendInput(input: { kind: "mouse" | "key"; payload: Record<string, unknown> }): boolean
}

/** What `browser_runtime_status` answers — the only RPC served uncompiled. */
interface BrowserRuntimeStatus {
  compiled: boolean
  enabled: boolean
  configured: boolean
  healthy: boolean
  reason?: string | null
}

export interface RemoteBrowserPreviewProps {
  chatSessionId: string
  parentChatSessionId?: string
  workspaceId: string
  profileId?: string
  initialUrl?: string
  createStream?: (options: RemoteBrowserStreamOptions) => StreamLike
}

/**
 * Where this shell's frame stream lives.
 *
 * A desktop driving a remote host keeps its identity in the remote-host store,
 * not the module-level companion cache, so reading only that cache resolved
 * `null` and the stream threw `browser_companion_unconfigured` before it ever
 * opened. `resolveCompanionEndpoint` is the resolver the terminal already uses
 * for the same reason.
 */
async function resolveStreamEndpoint(): Promise<CompanionEndpoint | null> {
  const endpoint = await defaultCompanionEndpointResolver()
  if (endpoint) return endpoint
  const fallback = buildTimeServerUrl()
  return fallback ? ({ baseUrl: fallback } as CompanionEndpoint) : null
}

function mouseButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle"
  if (button === 2) return "right"
  return "left"
}

function RemoteRecorder({
  engine,
  pageUrl,
  onSendToChat,
}: {
  engine: RemoteChromiumEngine
  pageUrl: string | null
  onSendToChat: (markdown: string) => void
}) {
  const driver = useMemo(() => createEngineRecordingDriver(engine), [engine])
  const recorder = useFlowRecorder({
    engine,
    driver,
    listenToPaneEvents: false,
  })
  const { noteLoaded, noteNavigation } = recorder

  useEffect(() => {
    if (!pageUrl) return
    noteNavigation(pageUrl)
    void noteLoaded()
  }, [noteLoaded, noteNavigation, pageUrl])

  return (
    <BrowserRecorderPanel
      chrome={false}
      pageUrl={pageUrl}
      recorder={recorder}
      onSendToChat={onSendToChat}
    />
  )
}

/** Cloud/mobile browser preview backed by a private WorkspaceRuntime Chromium. */
export function RemoteBrowserPreview({
  chatSessionId,
  parentChatSessionId,
  workspaceId,
  profileId,
  initialUrl,
  createStream = (options) => new RemoteBrowserStream(options),
}: RemoteBrowserPreviewProps) {
  const t = useTranslations("browser.remote")
  const browserT = useTranslations("browser")
  const actionsT = useTranslations("browser.actions")
  const screenshotT = useTranslations("browser.screenshot")
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<StreamLike | null>(null)
  const engineRef = useRef<RemoteChromiumEngine | null>(null)
  const frameSizeRef = useRef({ width: 1, height: 1 })
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [connection, setConnection] = useState<RemoteBrowserConnectionState>("connecting")
  const [engine, setEngine] = useState<RemoteChromiumEngine | null>(null)
  const [pages, setPages] = useState<BrowserPageSummary[]>([])
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [lease, setLease] = useState<RemoteBrowserLease | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  /** Why the runtime is not usable, straight from the gateway. */
  const [runtimeReason, setRuntimeReason] = useState<string | null>(null)
  const engineRefForDevtools = engine
  const devtools = useBrowserDevtools({
    poll: useMemo(
      () =>
        engineRefForDevtools
          ? {
              readConsole: () => engineRefForDevtools.readConsole(),
              readNetwork: () => engineRefForDevtools.readNetwork(),
            }
          : null,
      [engineRefForDevtools]
    ),
  })
  const [urlInput, setUrlInput] = useState(initialUrl ?? "")
  const [clickPointer, setClickPointer] = useState<{ x: number; y: number; key: number } | null>(
    null
  )
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [findOpen, setFindOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<BrowserSelection | null>(null)
  const [comment, setComment] = useState("")
  const [sendingComment, setSendingComment] = useState(false)
  const {
    recent: recentHistory,
    push: pushHistory,
    goBack: historyGoBack,
    goForward: historyGoForward,
    canGoBack,
    canGoForward,
    clear: clearHistory,
  } = useBrowserHistory()
  const { sendComment, sendScreenshotBytes, sendText } = useSelectionToChat()
  const activePage =
    pages.find((page) => page.id === activePageId) ?? pages.find((page) => page.active)

  useEffect(() => {
    let disposed = false
    let reconnectAttempts = 0

    const drawFrame = async (frame: RemoteBrowserFrame) => {
      frameSizeRef.current = { width: frame.width, height: frame.height }
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = frame.width
      canvas.height = frame.height
      const jpegBytes = new Uint8Array(frame.jpeg.byteLength)
      jpegBytes.set(frame.jpeg)
      const bitmap = await createImageBitmap(new Blob([jpegBytes.buffer], { type: "image/jpeg" }))
      if (disposed) {
        bitmap.close()
        return
      }
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, frame.width, frame.height)
      bitmap.close()
    }

    const setup = async () => {
      try {
        setConnection("connecting")
        const readiness = await transport.call<{ capabilities: string[] }>("browser_capability", {
          workspaceId,
          userEnabled: true,
        })
        if (!readiness.capabilities.includes("browser")) {
          throw new Error("browser_remote_disabled")
        }
        const [grants, profiles] = await Promise.all([
          listBrowserDomainGrants(workspaceId),
          listBrowserProfiles(workspaceId),
        ])
        const effectiveProfileId = profileId ?? profiles.find((candidate) => candidate.selected)?.id
        const inheritedParent =
          parentChatSessionId ?? decodeSubSession(chatSessionId)?.teamSessionId
        const summary = await transport.call<RemoteSessionRpcSummary>("browser_session_ensure", {
          chatSessionId,
          ...(inheritedParent ? { parentChatSessionId: inheritedParent } : {}),
          workspaceId,
          backendPreference: "remote-chromium",
          userEnabled: true,
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          domainGrants: grants.map((grant) => grant.domain),
        })
        if (effectiveProfileId) {
          await touchBrowserProfile(effectiveProfileId).catch(() => {})
        }
        if (disposed) return
        const engine = new RemoteChromiumEngine(summary.id)
        engineRef.current = engine
        setEngine(engine)
        // `browser_runtime_status` is the one RPC the gateway answers even when
        // the runtime feature is not compiled, so it is how a client learns the
        // difference between "not built", "switched off" and "unhealthy"
        // instead of assuming health and failing later, opaquely.
        const status = await transport
          .call<BrowserRuntimeStatus>("browser_runtime_status", { workspaceId })
          .catch(() => null)
        if (status && !status.healthy) {
          setRuntimeReason(status.reason ?? "browser_runtime_unhealthy")
        }
        configureRemoteBrowserEngine(engine, {
          enabled: status?.enabled ?? true,
          healthy: status?.healthy ?? true,
        })
        if (initialUrl) await engine.navigate(initialUrl)
        const currentPages = await engine.listPages()
        if (disposed) return
        setPages(currentPages)
        setActivePageId(currentPages.find((page) => page.active)?.id ?? summary.activePageId)

        const endpoint = await resolveStreamEndpoint()
        if (!endpoint?.baseUrl) throw new Error("browser_companion_unconfigured")
        const stream = createStream({
          sessionId: summary.id,
          serverBaseUrl: endpoint.baseUrl,
          issueTicket: () =>
            endpoint.deviceId
              ? issueSocketTicket(endpoint as CompanionConfig, {
                  channel: "browser",
                  sessionId: summary.id,
                })
              : issueCompanionSocketTicket({ channel: "browser", sessionId: summary.id }),
          onFrame: (frame) => void drawFrame(frame),
          onLease: setLease,
          onEvent: (event) => {
            if (event.kind === "pages.changed" && Array.isArray(event.pages)) {
              const nextPages = event.pages as BrowserPageSummary[]
              const nextActivePageId =
                typeof event.activePageId === "string" ? event.activePageId : null
              const active =
                nextPages.find((page) => page.id === nextActivePageId) ??
                nextPages.find((page) => page.active)
              setPages(nextPages)
              setActivePageId(nextActivePageId ?? active?.id ?? null)
              if (active) {
                setUrlInput(active.url)
                pushHistory(active.url)
              }
            } else if (event.kind === "control.changed") {
              setLease((event.lease as RemoteBrowserLease | undefined) ?? null)
            }
          },
          onError: setErrorCode,
          onState: (state) => {
            if (disposed) return
            setConnection(state)
            if (state === "connected") reconnectAttempts = 0
            if (state === "offline" && reconnectAttempts < 5) {
              reconnectAttempts += 1
              setConnection("reconnecting")
              reconnectTimerRef.current = setTimeout(
                () => void stream.connect().catch(() => setConnection("failed")),
                Math.min(1_000 * reconnectAttempts, 5_000)
              )
            }
          },
        })
        streamRef.current = stream
        await stream.connect()
      } catch (error) {
        if (disposed) return
        setErrorCode(error instanceof Error ? error.message : "browser_remote_unavailable")
        setConnection("failed")
      }
    }

    void setup()
    return () => {
      disposed = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      streamRef.current?.close()
      streamRef.current = null
      engineRef.current = null
      setEngine(null)
      configureRemoteBrowserEngine(null)
    }
  }, [
    chatSessionId,
    parentChatSessionId,
    workspaceId,
    profileId,
    initialUrl,
    createStream,
    pushHistory,
  ])

  const refreshPages = async () => {
    const next = await engineRef.current?.listPages()
    if (!next) return
    setPages(next)
    setActivePageId(next.find((page) => page.active)?.id ?? null)
    const active = next.find((page) => page.active)
    if (active) {
      setUrlInput(active.url)
      pushHistory(active.url)
    }
  }

  const navigate = async (event: FormEvent) => {
    event.preventDefault()
    if (!urlInput.trim()) return
    try {
      await engineRef.current?.navigate(urlInput.trim())
      await refreshPages()
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "browser_navigation_failed")
    }
  }

  const switchPage = async (pageId: string) => {
    await engineRef.current?.activatePage(pageId)
    await refreshPages()
  }

  const closePage = async (pageId: string) => {
    await engineRef.current?.closePage(pageId)
    await refreshPages()
  }

  const handleZoom = (next: number) => {
    setZoom(next)
    void engineRef.current?.setZoom(next).catch(() => {})
  }
  const runFind = (query: string, options: { forward: boolean }) =>
    engineRef.current?.find(query, options) ?? Promise.resolve({ matches: 0, index: 0 })
  const closeFind = () => {
    setFindOpen(false)
    void engineRef.current?.findClear().catch(() => {})
  }
  const navigateHistory = (url: string) => {
    setUrlInput(url)
    void engineRef.current
      ?.navigate(url)
      .then(refreshPages)
      .catch((error) =>
        setErrorCode(error instanceof Error ? error.message : "browser_navigation_failed")
      )
  }

  const captureToChat = async () => {
    if (!engineRef.current) return
    setCapturing(true)
    try {
      const shot = await engineRef.current.screenshot()
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

  const pickRemoteElement = async (event: PointerEvent<HTMLCanvasElement>) => {
    const point = pointerPayload(event)
    try {
      const snapshot = await engineRef.current?.snapshot({ includeText: true })
      if (!snapshot) return
      const candidates = snapshot.nodes.filter((node: SnapshotNode) => {
        if (node.frame) return false
        const { x, y, width, height } = node.rect
        return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
      })
      const target = candidates.sort(
        (left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height
      )[0]
      if (!target) return
      const evaluated = await engineRef.current?.evaluate(
        `window.__cogniaSelectionForRef(${JSON.stringify(target.ref)})`
      )
      if (!evaluated?.ok) throw new Error(evaluated?.error ?? "browser_selection_failed")
      const envelope =
        typeof evaluated.value === "string" ? JSON.parse(evaluated.value) : evaluated.value
      if (
        !envelope ||
        typeof envelope !== "object" ||
        !("selection" in envelope) ||
        !envelope.selection
      ) {
        throw new Error("browser_selection_failed")
      }
      setSelection(envelope.selection as BrowserSelection)
      setSelectMode(false)
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "browser_selection_failed")
    }
  }

  const sendSelectionComment = async () => {
    if (!selection || !comment.trim()) return
    setSendingComment(true)
    try {
      const sent = await sendComment(selection, comment.trim(), {
        sessionId: chatSessionId,
      })
      if (sent) {
        setSelection(null)
        setComment("")
      }
    } finally {
      setSendingComment(false)
    }
  }

  const pointerPayload = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const frame = frameSizeRef.current
    return {
      x: Math.max(
        0,
        Math.min(frame.width, ((event.clientX - rect.left) / rect.width) * frame.width)
      ),
      y: Math.max(
        0,
        Math.min(frame.height, ((event.clientY - rect.top) / rect.height) * frame.height)
      ),
      button: mouseButton(event.button),
      clickCount: 1,
    }
  }

  const showClickPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))
    setClickPointer((previous) => ({ x, y, key: (previous?.key ?? 0) + 1 }))
  }

  const sendKey = (event: KeyboardEvent<HTMLCanvasElement>, type: "keyDown" | "keyUp") => {
    if (!lease || lease.controller.kind !== "human") return
    event.preventDefault()
    streamRef.current?.sendInput({
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

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col" data-testid="remote-browser-preview">
        <BrowserToolbar
          toolbarRef={toolbarRef}
          loading={connection === "connecting" || connection === "reconnecting"}
          url={urlInput}
          onUrlChange={setUrlInput}
          onSubmit={(event) => void navigate(event)}
          addressDisplay={
            urlInput === (activePage?.url ?? "") ? addressDisplayParts(urlInput) : null
          }
          collapsedActive={selectMode || findOpen || zoom !== 1}
          navigation={
            <BrowserNavigationControls
              disabled={connection !== "connected"}
              backDisabled={!canGoBack}
              forwardDisabled={!canGoForward}
              onBack={() => {
                if (!historyGoBack()) return
                void engineRef.current
                  ?.back()
                  .then(refreshPages)
                  .catch(() => {})
              }}
              onForward={() => {
                if (!historyGoForward()) return
                void engineRef.current
                  ?.forward()
                  .then(refreshPages)
                  .catch(() => {})
              }}
              onReload={() => {
                void engineRef.current
                  ?.reload()
                  .then(refreshPages)
                  .catch(() => {})
              }}
            />
          }
          inspectActions={
            <>
              <BrowserHistoryMenu
                recent={recentHistory}
                onNavigate={navigateHistory}
                onClear={clearHistory}
                disabled={recentHistory.length === 0}
              />
              <TooltipIconButton
                tooltip={actionsT("screenshot")}
                aria-label={actionsT("screenshot")}
                disabled={connection !== "connected" || capturing}
                onClick={() => void captureToChat()}
              >
                {capturing ? <Loader2Icon className="animate-spin" /> : <CameraIcon />}
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={selectMode ? actionsT("cancelSelect") : actionsT("selectElement")}
                aria-label={selectMode ? actionsT("cancelSelect") : actionsT("selectElement")}
                disabled={connection !== "connected"}
                className={cn(selectMode && "bg-primary/15 text-primary")}
                onClick={() => setSelectMode((enabled) => !enabled)}
              >
                <MousePointerSquareDashedIcon />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={t("find")}
                aria-label={t("find")}
                disabled={connection !== "connected"}
                className={cn(findOpen && "bg-primary/15 text-primary")}
                onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
              >
                <SearchIcon />
              </TooltipIconButton>
            </>
          }
          pageActions={
            <>
              <BrowserZoomControl
                zoom={zoom}
                onZoomChange={handleZoom}
                disabled={connection !== "connected"}
              />
              {/* Embedded-only by construction: it reads this machine's
                  Chromium keychain into this machine's WKWebView store. Shown
                  disabled with that reason rather than omitted, so its absence
                  cannot read as a bug. */}
              <BrowserCookieImportAction
                backend="remote"
                currentUrl={null}
                onReload={() => Promise.resolve()}
              />
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
            <>
              <Badge variant="outline" className="shrink-0 gap-1" aria-live="polite">
                {connection === "connecting" || connection === "reconnecting" ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : connection === "failed" || connection === "offline" ? (
                  <CloudOffIcon className="size-3" />
                ) : (
                  <MonitorUpIcon className="size-3" />
                )}
                {t(`connection.${connection}`)}
              </Badge>
              <Button
                size="sm"
                className="shrink-0"
                variant={lease?.controller.kind === "human" ? "secondary" : "default"}
                onClick={() => streamRef.current?.takeover()}
                aria-label={t("takeover")}
              >
                {lease?.controller.kind === "human" ? t("humanControl") : t("takeover")}
              </Button>
            </>
          }
        />

        {findOpen && <BrowserFindBarSection onSearch={runFind} onClose={closeFind} />}

        {pages.length > 0 && (
          <div className="flex gap-1 overflow-x-auto border-b bg-muted/30 px-2 py-1">
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
                  className="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs"
                  aria-label={page.title || page.url || t("untitledPage")}
                  onClick={() => void switchPage(page.id)}
                >
                  {page.title || page.url || t("untitledPage")}
                </button>
                {pages.length > 1 && (
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    aria-label={t("closePage")}
                    onClick={() => void closePage(page.id)}
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="application"
            aria-label={t("canvas")}
            className={cn(
              "h-full w-full object-contain outline-none",
              selectMode
                ? "cursor-crosshair"
                : lease?.controller.kind === "human"
                  ? "cursor-default"
                  : "cursor-not-allowed"
            )}
            onPointerMove={(event) =>
              streamRef.current?.sendInput({
                kind: "mouse",
                payload: { type: "mouseMoved", ...pointerPayload(event) },
              })
            }
            onPointerDown={(event) => {
              event.currentTarget.focus()
              if (selectMode) {
                void pickRemoteElement(event)
                return
              }
              showClickPointer(event)
              streamRef.current?.sendInput({
                kind: "mouse",
                payload: { type: "mousePressed", ...pointerPayload(event) },
              })
            }}
            onPointerUp={(event) => {
              if (selectMode) return
              streamRef.current?.sendInput({
                kind: "mouse",
                payload: { type: "mouseReleased", ...pointerPayload(event) },
              })
            }}
            onWheel={(event) => {
              event.preventDefault()
              streamRef.current?.sendInput({
                kind: "mouse",
                payload: {
                  type: "mouseWheel",
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
              data-testid="remote-browser-click-pointer"
              className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-red-500 bg-red-500/20"
              style={{ left: `${clickPointer.x}%`, top: `${clickPointer.y}%` }}
              aria-hidden
            />
          )}
          {connection !== "connected" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {errorCode
                  ? t("error", { code: errorCode })
                  : runtimeReason
                    ? t("runtimeUnavailable", { reason: runtimeReason })
                    : t("waiting")}
              </p>
            </div>
          )}
          {selection && (
            <div className="absolute inset-x-3 bottom-3 rounded-lg border bg-background p-3 shadow-lg">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {selection.selector}
                </p>
                <TooltipIconButton
                  tooltip={browserT("comment.cancel")}
                  aria-label={browserT("comment.cancel")}
                  size="icon-xs"
                  onClick={() => {
                    setSelection(null)
                    setComment("")
                  }}
                >
                  <XIcon />
                </TooltipIconButton>
              </div>
              <Textarea
                autoFocus
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={browserT("comment.placeholder")}
                aria-label={browserT("comment.title")}
                rows={2}
                className="resize-none text-sm"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  disabled={sendingComment || !comment.trim()}
                  onClick={() => void sendSelectionComment()}
                >
                  <SendIcon />
                  {browserT("comment.send")}
                </Button>
              </div>
            </div>
          )}
        </div>
        {/* The same single strip the embedded pane uses. Console and network
            arrive by polling here: a remote session has no push channel into
            this renderer, but the engine implements the same drains. */}
        {engine && (
          <BrowserToolsDock
            consoleCount={devtools.console.length}
            networkCount={devtools.network.length}
            problemCount={devtools.problemCount}
            failedRequests={devtools.failedRequests}
            recorder={
              <RemoteRecorder
                engine={engine}
                pageUrl={activePage?.url ?? null}
                onSendToChat={(markdown) => void sendText(markdown, { sessionId: chatSessionId })}
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
      </div>
    </TooltipProvider>
  )
}
