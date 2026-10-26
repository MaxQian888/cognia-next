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
  type ReactNode,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { toast } from "sonner"
import Link from "next/link"
import { useLiveQuery } from "dexie-react-hooks"

import { BrowserFindBarSection, isFindShortcut } from "@/components/browser/browser-find-bar"
import { BrowserHistoryMenu } from "@/components/browser/browser-history-menu"
import { BrowserLoadError } from "@/components/browser/browser-load-error"
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useBrowserHistory } from "@/hooks/browser/use-browser-history"
import { useRecentPages } from "@/hooks/browser/use-recent-pages"
import { useFlowRecorder } from "@/hooks/browser/use-flow-recorder"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { configureRemoteBrowserEngine, type BrowserEngine } from "@/lib/browser/agent-engine"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import {
  RemoteChromiumEngine,
  REMOTE_BROWSER_APPROVAL_OPERATIONS,
} from "@/lib/browser/remote-chromium-engine"
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
  canvasPointToFrame,
  type RemoteBrowserConnectionState,
  type RemoteBrowserFrame,
  type RemoteBrowserLease,
  type RemoteBrowserStreamOptions,
} from "@/lib/browser/remote-stream"
import { createFramePainter } from "@/lib/browser/frame-painter"
import { REMOTE_BROWSER_SETTINGS_HREF } from "@/lib/browser/preview-data"
import type { BrowserPageSummary } from "@/lib/browser/session-types"
import {
  normalizePreviewUrl,
  type BrowserSelection,
  type SnapshotNode,
} from "@/lib/browser/protocol"
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
import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"
import { createInteractiveApprovalScope } from "@/lib/tauri/interactive-approval"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

interface RemoteSessionRpcSummary {
  id: string
  state: string
  pages: BrowserPageSummary[]
  activePageId: string | null
  profileId?: string | null
  domainGrants?: string[]
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
  /**
   * An address the host is asking this surface to go to now, e.g. a link the
   * user clicked in the conversation. See `BrowserPreviewPane`'s prop of the
   * same name.
   *
   * Deliberately not folded into `initialUrl`: that one is a dependency of the
   * connect effect, so writing a live address into it would tear down and
   * rebuild the whole remote session on every click.
   */
  requestedUrl?: string
  /**
   * Which request `requestedUrl` belongs to. The same address stated twice is
   * two requests; without this the second one deduplicated away.
   */
  requestNonce?: number
  /**
   * Switch this pane back to the shell's lightweight preview: embedded webview
   * on desktop, sandboxed iframe on Web.
   */
  onBackendChange?: (backend: BrowserBackend) => void
  onNavigated?: (url: string) => void
  /**
   * The desktop's full engine switch (ADR-0201). Takes the place of the
   * two-way select `onBackendChange` draws, which predates the local engines.
   */
  backendSwitcher?: ReactNode
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

/** Console / network poll rate while the dock's readouts are open, and while not. */
const DEVTOOLS_POLL_MS = 1_500
const DEVTOOLS_IDLE_POLL_MS = 6_000
const createRemoteStream = (options: RemoteBrowserStreamOptions) => new RemoteBrowserStream(options)

function mouseButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle"
  if (button === 2) return "right"
  return "left"
}

/**
 * The flow recorder for a runtime-backed engine (cloud or local Chromium): the
 * page is driven through the engine, so recording goes through it too rather
 * than through the embedded webview's pane events.
 */
export function EngineRecorder({
  engine,
  pageUrl,
  onSendToChat,
  onRecordingChange,
}: {
  engine: BrowserEngine
  pageUrl: string | null
  onSendToChat: (markdown: string) => void
  onRecordingChange: (steps: number | null) => void
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
      pageUrl={pageUrl}
      recorder={recorder}
      onSendToChat={onSendToChat}
      onRecordingChange={onRecordingChange}
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
  requestedUrl,
  requestNonce,
  onBackendChange,
  onNavigated,
  backendSwitcher,
  createStream = createRemoteStream,
}: RemoteBrowserPreviewProps) {
  const t = useTranslations("browser.remote")
  const browserT = useTranslations("browser")
  const actionsT = useTranslations("browser.actions")
  const screenshotT = useTranslations("browser.screenshot")
  const commentT = useTranslations("browser.comment")
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
  const [navigationFailure, setNavigationFailure] = useState<string | null>(null)
  const navigationAttemptRef = useRef(0)
  const urlInputRef = useRef<HTMLInputElement>(null)
  /** Why the runtime is not usable, straight from the gateway. */
  const [runtimeReason, setRuntimeReason] = useState<string | null>(null)
  const [connectAttempt, setConnectAttempt] = useState(0)
  const retryUrlRef = useRef<string | null>(null)
  const pendingReconnectRef = useRef<Promise<unknown> | null>(null)
  const reconnectProfileRef = useRef<{ profileId: string | null } | null>(null)
  const [remoteSession, setRemoteSession] = useState<{
    id: string
    profileId: string | null
  } | null>(null)
  const configuredGrants = useLiveQuery(() => listBrowserDomainGrants(workspaceId), [workspaceId])
  const [appliedGrants, setAppliedGrants] = useState<string[] | null>(null)
  const [confirmReconnect, setConfirmReconnect] = useState(false)
  const [blockedDomains, setBlockedDomains] = useState<string[]>([])
  const [urlInput, setUrlInput] = useState(initialUrl ?? "")
  const [approvalRequired, setApprovalRequired] = useState(false)
  const [approving, setApproving] = useState(false)
  const [consentCode, setConsentCode] = useState<string | null>(null)
  const [approvalFailed, setApprovalFailed] = useState(false)
  const targetScope = useSyncExternalStore(
    subscribeRuntimeTargetContext,
    getRuntimeTargetScopeKey,
    getRuntimeTargetScopeKey
  )
  const approval = useMemo(
    () =>
      createInteractiveApprovalScope(REMOTE_BROWSER_APPROVAL_OPERATIONS, { scopeKey: targetScope }),
    [targetScope]
  )
  useEffect(() => () => approval.clear(), [approval])
  const browserCaller = useMemo<Pick<Transport, "call">>(
    () => ({
      async call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
        try {
          return await approval.call<T>(name, args)
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "interactive_approval_required" ||
              error.code === "approval_target_changed")
          ) {
            setApprovalRequired(true)
            setConsentCode(null)
          }
          throw error
        }
      },
    }),
    [approval]
  )
  const authorizeBrowser = async () => {
    if (approving) return
    setApproving(true)
    setApprovalFailed(false)
    try {
      await approval.authorize()
      setApprovalRequired(false)
      setConsentCode(null)
      if (connection !== "connected") {
        retryUrlRef.current = recoveryUrl || null
        setConnectAttempt((attempt) => attempt + 1)
      }
    } catch (error) {
      setConsentCode(error instanceof HostConsentRequiredError ? error.consentCode : null)
      setApprovalFailed(!(error instanceof HostConsentRequiredError))
    } finally {
      setApproving(false)
    }
  }
  const approvalMessage = consentCode
    ? t("approval.pending", { code: consentCode })
    : t(approvalFailed ? "approval.failed" : "approval.required")
  const grantsChanged =
    appliedGrants !== null &&
    configuredGrants !== undefined &&
    JSON.stringify([...appliedGrants].sort()) !==
      JSON.stringify(configuredGrants.map((grant) => grant.domain).sort())
  /** Whether the dock's readouts are on screen; polling slows while they are not. */
  const [toolsExpanded, setToolsExpanded] = useState(false)
  /** The live take's step count, for the dock header; null when not recording. */
  const [recordingSteps, setRecordingSteps] = useState<number | null>(null)
  // A remote session has no push channel into this renderer, so the rings fill
  // by polling — a network round-trip per tick. Full rate only while someone is
  // reading them; a slow background tick keeps the collapsed badges honest.
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
    push: pushHistory,
    goBack: historyGoBack,
    goForward: historyGoForward,
    canGoBack,
    canGoForward,
  } = useBrowserHistory()
  const { recent: recentHistory, clear: clearRecentPages } = useRecentPages()
  const clearHistory = () => {
    void clearRecentPages().then((cleared) => {
      if (!cleared) toast.error(browserT("history.clearFailed"))
    })
  }
  const { sendComment, sendScreenshotBytes, sendText } = useSelectionToChat()
  const activePage =
    pages.find((page) => page.id === activePageId) ?? pages.find((page) => page.active)
  const recoveryUrl = normalizePreviewUrl(navigationFailure ?? urlInput) ?? initialUrl ?? ""
  useEffect(() => {
    const url = normalizePreviewUrl(activePage?.url ?? requestedUrl ?? initialUrl ?? "")
    if (url) onNavigated?.(url)
  }, [activePage?.url, requestedUrl, initialUrl, onNavigated])
  const refreshBlockedDomains = useCallback(async () => {
    const current = engineRef.current
    const result = await current?.snapshot({ includeText: false }).catch(() => null)
    if (current && engineRef.current === current && result)
      setBlockedDomains(result.blockedDomains ?? [])
  }, [])

  useEffect(() => {
    let disposed = false
    let reconnectAttempts = 0

    const painter = createFramePainter(() => canvasRef.current)
    const drawFrame = (frame: RemoteBrowserFrame) => {
      if (disposed) return
      frameSizeRef.current = { width: frame.width, height: frame.height }
      painter.paint(frame)
    }

    const setup = async () => {
      try {
        setConnection("connecting")
        setErrorCode(null)
        setRuntimeReason(null)
        setNavigationFailure(null)
        const pendingReconnect = pendingReconnectRef.current
        if (pendingReconnect) {
          try {
            await pendingReconnect
          } finally {
            if (pendingReconnectRef.current === pendingReconnect) pendingReconnectRef.current = null
          }
        }
        if (disposed) return
        /*
          Asked FIRST, and that ordering is the whole point.

          `browser_runtime_status` is the one RPC the gateway answers when the
          `workspace-runtime-exec` feature is not compiled; every other one,
          `browser_capability` included, is refused with `browser_disabled`.
          Asking it last meant the build that most needs the explanation never
          reached it: the capability probe threw first and the pane rendered a
          bare error code, while the sentence that says "this build does not
          include the remote runtime" sat behind a call that could not run.
        */
        const status = await transport
          .call<BrowserRuntimeStatus>("browser_runtime_status", { workspaceId })
          .catch(() => null)
        if (status && !status.healthy) {
          setRuntimeReason(status.reason ?? "browser_runtime_unhealthy")
        }
        if (disposed) return
        // Nothing downstream can succeed without the runtime, and every one of
        // those calls fails in a vocabulary the pane cannot translate. Stop on
        // the honest reason instead of collecting a second, worse one.
        if (
          status &&
          (!status.compiled || !status.enabled || !status.configured || !status.healthy)
        ) {
          setConnection("failed")
          return
        }
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
        const effectiveProfileId = reconnectProfileRef.current
          ? reconnectProfileRef.current.profileId
          : (profileId ?? profiles.find((candidate) => candidate.selected)?.id)
        const inheritedParent =
          parentChatSessionId ?? decodeSubSession(chatSessionId)?.teamSessionId
        const summary = await browserCaller.call<RemoteSessionRpcSummary>(
          "browser_session_ensure",
          {
            chatSessionId,
            ...(inheritedParent ? { parentChatSessionId: inheritedParent } : {}),
            workspaceId,
            backendPreference: "remote-chromium",
            userEnabled: true,
            ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
            domainGrants: grants.map((grant) => grant.domain),
          }
        )
        if (disposed) return
        reconnectProfileRef.current = null
        setRemoteSession({
          id: summary.id,
          profileId:
            summary.profileId !== undefined ? summary.profileId : (effectiveProfileId ?? null),
        })
        setAppliedGrants(summary.domainGrants ?? grants.map((grant) => grant.domain))
        if (effectiveProfileId) {
          await touchBrowserProfile(effectiveProfileId).catch(() => {})
        }
        if (disposed) return
        const engine = new RemoteChromiumEngine(summary.id, browserCaller)
        engineRef.current = engine
        setEngine(engine)
        configureRemoteBrowserEngine(engine, {
          enabled: status?.enabled ?? true,
          healthy: status?.healthy ?? true,
        })
        const startUrl = retryUrlRef.current ?? initialUrl
        retryUrlRef.current = null
        let navigationFailed = false
        if (startUrl) {
          try {
            await engine.navigate(startUrl)
          } catch {
            navigationFailed = true
            // The runtime can still connect and offer navigation recovery.
            if (!disposed) {
              setNavigationFailure(startUrl)
              setUrlInput(startUrl)
            }
          }
        }
        const currentPages = await engine.listPages()
        if (disposed) return
        setPages(currentPages)
        const currentPage = currentPages.find((page) => page.active)
        setActivePageId(currentPage?.id ?? summary.activePageId)
        if (currentPage && !navigationFailed) setUrlInput(currentPage.url)
        await refreshBlockedDomains()
        if (disposed) return

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
          onFrame: drawFrame,
          onLease: (next) => {
            if (!disposed) setLease(next)
          },
          onEvent: (event) => {
            if (disposed) return
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
          onError: (code) => {
            if (!disposed) setErrorCode(code)
          },
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
      navigationAttemptRef.current += 1
      painter.dispose()
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
    connectAttempt,
    refreshBlockedDomains,
    browserCaller,
  ])

  const refreshPages = useCallback(async () => {
    const next = await engineRef.current?.listPages()
    if (!next) return
    setPages(next)
    setActivePageId(next.find((page) => page.active)?.id ?? null)
    const active = next.find((page) => page.active)
    if (active) {
      setUrlInput(active.url)
      pushHistory(active.url)
    }
  }, [pushHistory])

  const runNavigation = useCallback(
    async (url: string, work: () => Promise<unknown>, refresh = true) => {
      const attempt = ++navigationAttemptRef.current
      setNavigationFailure(null)
      try {
        await work()
        if (attempt !== navigationAttemptRef.current) return
        if (refresh) await refreshPages()
        else pushHistory(url)
      } catch (error) {
        if (attempt !== navigationAttemptRef.current) return
        setNavigationFailure(url)
        setErrorCode(error instanceof Error ? error.message : "browser_navigation_failed")
      }
      await refreshBlockedDomains()
    },
    [refreshPages, pushHistory, refreshBlockedDomains]
  )

  const navigatePage = useCallback(
    async (url: string) => {
      const current = engineRef.current
      if (!current) return
      setUrlInput(url)
      onNavigated?.(url)
      await runNavigation(url, () => current.navigate(url))
    },
    [runNavigation, onNavigated]
  )

  // Follow an address the host states. Recorded during render so the toolbar
  // shows it on the same frame the panel appears, then navigated once an engine
  // exists, which is what lets a link clicked before the stream finished
  // connecting still arrive instead of being dropped.
  //
  // Tracked by request token, not by address: the user can navigate away inside
  // this surface, and re-stating the page they left is then a real request that
  // an address-only comparison threw away.
  const [applied, setApplied] = useState<{ key: string; url: string } | null>(null)
  const requestKey = requestedUrl ? `${requestNonce ?? 0}:${requestedUrl}` : null
  if (requestedUrl && requestKey !== applied?.key) {
    setApplied({ key: requestKey as string, url: requestedUrl })
    setUrlInput(requestedUrl)
  }
  const appliedKey = applied?.key ?? null
  const appliedRequestedUrl = applied?.url ?? null
  /**
   * The request key this surface has already navigated for.
   *
   * `engine` is a dependency below because a link clicked before the stream
   * finished connecting has to arrive once one exists. That alone would also
   * replay the request on every RECONNECT, though: the connect effect swaps the
   * engine, and a delivered address would be navigated again, dragging the user
   * back from wherever they had browsed to. The key says which of the two this
   * is, so waiting for an engine and re-serving a delivered request stay
   * separable.
   */
  const deliveredKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!appliedRequestedUrl || !engine) return
    if (deliveredKeyRef.current === appliedKey) return
    deliveredKeyRef.current = appliedKey
    onNavigated?.(appliedRequestedUrl)
    void runNavigation(appliedRequestedUrl, () => engine.navigate(appliedRequestedUrl), false)
    // `appliedKey` is the dependency that makes a repeat of the same address
    // re-run this effect. `appliedRequestedUrl` alone would not change.
  }, [appliedKey, appliedRequestedUrl, engine, runNavigation, onNavigated])

  const navigate = async (event: FormEvent) => {
    event.preventDefault()
    if (!urlInput.trim()) return
    await navigatePage(urlInput.trim())
  }

  const switchPage = async (pageId: string) => {
    navigationAttemptRef.current += 1
    setNavigationFailure(null)
    await engineRef.current?.activatePage(pageId)
    await refreshPages()
  }

  const closePage = async (pageId: string) => {
    navigationAttemptRef.current += 1
    setNavigationFailure(null)
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
    void navigatePage(url)
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

  const dismissSelection = () => {
    setSelection(null)
    setComment("")
  }

  // Same outcomes, and the same words for them, as the embedded pane: a send
  // that could not be delivered used to leave the box open with no reason.
  const sendSelectionComment = async () => {
    if (!selection || !comment.trim()) return
    setSendingComment(true)
    try {
      const sent = await sendComment(selection, comment.trim(), {
        sessionId: chatSessionId,
      })
      if (sent) {
        toast.success(commentT("sent"))
        dismissSelection()
      } else {
        toast.error(commentT("noSession"))
      }
    } catch {
      toast.error(commentT("failed"))
    } finally {
      setSendingComment(false)
    }
  }

  const onCommentKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      dismissSelection()
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void sendSelectionComment()
    }
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
          urlInputRef={urlInputRef}
          onUrlChange={setUrlInput}
          onSubmit={(event) => void navigate(event)}
          addressDisplay={
            urlInput === (activePage?.url ?? "") ? addressDisplayParts(urlInput) : null
          }
          collapsedActive={selectMode || findOpen || zoom !== 1}
          overflowExtras={
            backendSwitcher ? (
              backendSwitcher
            ) : onBackendChange ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{browserT("backend.label")}</span>
                <NativeSelect
                  value="remote"
                  onChange={(event) => onBackendChange(event.target.value as BrowserBackend)}
                  aria-label={browserT("backend.label")}
                  size="sm"
                  wrapperClassName="w-full"
                  className="h-7 text-xs"
                >
                  <NativeSelectOption value="embedded">
                    {browserT("backend.embedded")}
                  </NativeSelectOption>
                  <NativeSelectOption value="remote">
                    {browserT("backend.remote")}
                  </NativeSelectOption>
                </NativeSelect>
              </div>
            ) : undefined
          }
          navigation={
            <BrowserNavigationControls
              disabled={connection !== "connected"}
              backDisabled={!canGoBack}
              forwardDisabled={!canGoForward}
              onBack={() => {
                const url = historyGoBack()
                const current = engineRef.current
                if (url && current) void runNavigation(url, () => current.back())
              }}
              onForward={() => {
                const url = historyGoForward()
                const current = engineRef.current
                if (url && current) void runNavigation(url, () => current.forward())
              }}
              onReload={() => {
                const current = engineRef.current
                if (navigationFailure) void navigatePage(navigationFailure)
                else if (current)
                  void runNavigation(activePage?.url ?? urlInput, () => current.reload())
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
                disabled={!recoveryUrl}
                onClick={() => {
                  if (recoveryUrl) void openExternal(recoveryUrl)
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

        {approvalRequired && connection === "connected" && (
          <div
            role="status"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs"
          >
            <p className="min-w-0 flex-1 break-words">{approvalMessage}</p>
            <Button size="sm" disabled={approving} onClick={() => void authorizeBrowser()}>
              {t("approval.authorize")}
            </Button>
          </div>
        )}
        {(grantsChanged || blockedDomains.length > 0) && (
          <div
            role="status"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs"
          >
            <p className="min-w-0 flex-1 break-words">
              {grantsChanged
                ? t("grants.changed")
                : t("grants.blocked", { domains: blockedDomains.join(", ") })}
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href={REMOTE_BROWSER_SETTINGS_HREF}>{t("grants.manage")}</Link>
            </Button>
            {grantsChanged && (
              <Button
                size="sm"
                disabled={connection !== "connected"}
                onClick={() => setConfirmReconnect(true)}
              >
                {t("grants.reconnect")}
              </Button>
            )}
          </div>
        )}
        <AlertDialog open={confirmReconnect} onOpenChange={setConfirmReconnect}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("grants.reconnect")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(remoteSession?.profileId ? "grants.persistentHint" : "grants.ephemeralHint")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("grants.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const session = remoteSession
                  if (!session || pendingReconnectRef.current) return
                  reconnectProfileRef.current = { profileId: session.profileId }
                  retryUrlRef.current = normalizePreviewUrl(
                    navigationFailure ?? activePage?.url ?? requestedUrl ?? initialUrl ?? ""
                  )
                  pendingReconnectRef.current = browserCaller.call("browser_session_close", {
                    browserSessionId: session.id,
                  })
                  setConnectAttempt((attempt) => attempt + 1)
                }}
              >
                {t("grants.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
          {connection === "failed" || connection === "offline" ? (
            <div className="absolute inset-0">
              <BrowserLoadError
                url={recoveryUrl}
                message={
                  approvalRequired
                    ? approvalMessage
                    : runtimeReason
                      ? t("runtimeUnavailable", { reason: runtimeReason })
                      : errorCode
                        ? t("error", { code: errorCode })
                        : t("connection.failed")
                }
                onRetry={() => {
                  if (approvalRequired) {
                    void authorizeBrowser()
                    return
                  }
                  retryUrlRef.current = recoveryUrl || null
                  setConnectAttempt((attempt) => attempt + 1)
                }}
                retryLabel={approvalRequired ? t("approval.authorize") : undefined}
                retryDisabled={approving}
                onEditAddress={() => urlInputRef.current?.focus()}
                onOpenExternal={recoveryUrl ? () => void openExternal(recoveryUrl) : undefined}
                onContinue={onBackendChange ? () => onBackendChange("embedded") : undefined}
                continueLabel={browserT("backend.embedded")}
              />
            </div>
          ) : (
            connection !== "connected" && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80 p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {errorCode
                    ? t("error", { code: errorCode })
                    : runtimeReason
                      ? t("runtimeUnavailable", { reason: runtimeReason })
                      : t("waiting")}
                </p>
              </div>
            )
          )}
          {connection === "connected" && navigationFailure && (
            <div className="absolute inset-0">
              <BrowserLoadError
                url={navigationFailure}
                onRetry={() => void navigatePage(navigationFailure)}
                onEditAddress={() => urlInputRef.current?.focus()}
                onOpenExternal={() => void openExternal(navigationFailure)}
              />
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
                  onClick={dismissSelection}
                >
                  <XIcon />
                </TooltipIconButton>
              </div>
              <Textarea
                autoFocus
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={onCommentKeyDown}
                placeholder={browserT("comment.placeholder")}
                aria-label={browserT("comment.title")}
                rows={2}
                className="resize-none text-sm"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">{browserT("comment.hint")}</p>
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
      </div>
    </TooltipProvider>
  )
}
