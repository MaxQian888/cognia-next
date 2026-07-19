"use client"

import { CloudOffIcon, Loader2Icon, MonitorUpIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  listBrowserDomainGrants,
  listBrowserProfiles,
  touchBrowserProfile,
} from "@/lib/db/browser-profiles"
import { RemoteChromiumEngine } from "@/lib/browser/remote-chromium-engine"
import { configureRemoteBrowserEngine } from "@/lib/browser/agent-engine"
import {
  RemoteBrowserStream,
  type RemoteBrowserConnectionState,
  type RemoteBrowserFrame,
  type RemoteBrowserLease,
  type RemoteBrowserStreamOptions,
} from "@/lib/browser/remote-stream"
import type { BrowserPageSummary } from "@/lib/browser/session-types"
import { buildTimeServerUrl } from "@/lib/platform/web-companion"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { transport } from "@/lib/tauri/transport-instance"
import { decodeSubSession } from "@/lib/claude/team-session-id"

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

export interface RemoteBrowserPreviewProps {
  chatSessionId: string
  parentChatSessionId?: string
  workspaceId: string
  profileId?: string
  initialUrl?: string
  createStream?: (options: RemoteBrowserStreamOptions) => StreamLike
}

function companionBaseUrl(): string | null {
  return loadCompanionConfig()?.baseUrl ?? buildTimeServerUrl()
}

function mouseButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle"
  if (button === 2) return "right"
  return "left"
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<StreamLike | null>(null)
  const engineRef = useRef<RemoteChromiumEngine | null>(null)
  const frameSizeRef = useRef({ width: 1, height: 1 })
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [connection, setConnection] = useState<RemoteBrowserConnectionState>("connecting")
  const [pages, setPages] = useState<BrowserPageSummary[]>([])
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [lease, setLease] = useState<RemoteBrowserLease | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState(initialUrl ?? "")

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
        configureRemoteBrowserEngine(engine, { enabled: true, healthy: true })
        if (initialUrl) await engine.navigate(initialUrl)
        const currentPages = await engine.listPages()
        if (disposed) return
        setPages(currentPages)
        setActivePageId(currentPages.find((page) => page.active)?.id ?? summary.activePageId)

        const baseUrl = companionBaseUrl()
        if (!baseUrl) throw new Error("browser_companion_unconfigured")
        const stream = createStream({
          sessionId: summary.id,
          serverBaseUrl: baseUrl,
          issueTicket: () =>
            transport.call("browser_stream_ticket_issue", { browserSessionId: summary.id }),
          onFrame: (frame) => void drawFrame(frame),
          onLease: setLease,
          onEvent: (event) => {
            if (event.kind === "pages.changed" && Array.isArray(event.pages)) {
              const nextPages = event.pages as BrowserPageSummary[]
              setPages(nextPages)
              setActivePageId(typeof event.activePageId === "string" ? event.activePageId : null)
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
      configureRemoteBrowserEngine(null)
    }
  }, [chatSessionId, parentChatSessionId, workspaceId, profileId, initialUrl, createStream])

  const refreshPages = async () => {
    const next = await engineRef.current?.listPages()
    if (!next) return
    setPages(next)
    setActivePageId(next.find((page) => page.active)?.id ?? null)
    const active = next.find((page) => page.active)
    if (active) setUrlInput(active.url)
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
    <div className="flex h-full min-h-0 flex-col" data-testid="remote-browser-preview">
      <div className="flex items-center gap-2 border-b p-2">
        <form className="min-w-0 flex-1" onSubmit={(event) => void navigate(event)}>
          <Input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            inputMode="url"
            aria-label={t("url")}
            placeholder={t("url")}
            className="h-8"
          />
        </form>
        <Badge variant="outline" className="gap-1" aria-live="polite">
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
          variant={lease?.controller.kind === "human" ? "secondary" : "default"}
          onClick={() => streamRef.current?.takeover()}
          aria-label={t("takeover")}
        >
          {lease?.controller.kind === "human" ? t("humanControl") : t("takeover")}
        </Button>
      </div>

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
            lease?.controller.kind === "human" ? "cursor-default" : "cursor-not-allowed"
          )}
          onPointerMove={(event) =>
            streamRef.current?.sendInput({
              kind: "mouse",
              payload: { type: "mouseMoved", ...pointerPayload(event) },
            })
          }
          onPointerDown={(event) => {
            event.currentTarget.focus()
            streamRef.current?.sendInput({
              kind: "mouse",
              payload: { type: "mousePressed", ...pointerPayload(event) },
            })
          }}
          onPointerUp={(event) =>
            streamRef.current?.sendInput({
              kind: "mouse",
              payload: { type: "mouseReleased", ...pointerPayload(event) },
            })
          }
          onKeyDown={(event) => sendKey(event, "keyDown")}
          onKeyUp={(event) => sendKey(event, "keyUp")}
        />
        {connection !== "connected" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {errorCode ? t("error", { code: errorCode }) : t("waiting")}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
