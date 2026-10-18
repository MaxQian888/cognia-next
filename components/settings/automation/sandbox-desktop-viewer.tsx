"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useSandboxDesktop } from "@/hooks/automation/use-sandbox-desktop"
import {
  useSandboxDesktopStream,
  type SandboxDesktopStreamDeps,
} from "@/hooks/automation/use-sandbox-desktop-stream"
import { screenshotMimeType } from "@/lib/automation/model-frame"
import type { Point, Screenshot } from "@/lib/automation/types"
import type { OpenSandboxDesktop, SandboxControlLease } from "@/lib/automation/sandbox-client"
import { isCapacitor } from "@/lib/platform/detect"
import { SandboxFileTransfer } from "./sandbox-file-transfer"

function framePoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
  frame: Screenshot
): Point | null {
  const rect = image.getBoundingClientRect()
  if (
    !rect.width ||
    !rect.height ||
    clientX < rect.left ||
    clientY < rect.top ||
    clientX > rect.right ||
    clientY > rect.bottom
  )
    return null
  const width = frame.sourceWidth ?? frame.width
  const height = frame.sourceHeight ?? frame.height
  return {
    x: Math.min(width - 1, Math.floor(((clientX - rect.left) / rect.width) * width)),
    y: Math.min(height - 1, Math.floor(((clientY - rect.top) / rect.height) * height)),
  }
}

/**
 * Screenshots stay inside the authenticated command transport; no raw desktop
 * endpoint is exposed. A local sandbox built with Selkies (ADR-0234 Phase 4)
 * is shown as its live stream instead: a loopback page with a Host-issued
 * session token that can only watch until this viewer holds the control lease.
 */
export function SandboxDesktopViewer({
  connectionId,
  enabled,
  containerId,
  openDesktop,
  observeOnly = false,
  streamDeps,
}: {
  connectionId: string
  enabled: boolean
  containerId?: string
  openDesktop?: OpenSandboxDesktop
  observeOnly?: boolean
  /** Test seam for the stream grant calls. */
  streamDeps?: SandboxDesktopStreamDeps
}) {
  const t = useTranslations("automation.sandboxConnections.desktopViewer")
  const mobileObservation =
    Boolean(openDesktop) &&
    (observeOnly ||
      isCapacitor() ||
      (typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)))
  // Only the client-local Docker desktop has a Selkies variant.
  const stream = useSandboxDesktopStream(connectionId, enabled && !openDesktop, streamDeps)
  const streaming = stream.grant !== null
  const releaseRef = useRef<(() => Promise<void> | undefined) | null>(null)
  const { claim: claimStream, reopen: reopenStream } = stream
  const onLeaseChange = useCallback(
    (lease: SandboxControlLease | null) => {
      if (!lease) {
        void reopenStream()
        return
      }
      // Control the stream cannot carry is control the user cannot use.
      void claimStream(lease).then((claimed) => {
        if (!claimed) void releaseRef.current?.()
      })
    },
    [claimStream, reopenStream]
  )
  const { frame, controlling, acquiring, error, acquire, release, refresh, input, status } =
    useSandboxDesktop(connectionId, enabled, openDesktop, !mobileObservation, {
      streaming,
      onLeaseChange: openDesktop ? undefined : onLeaseChange,
    })
  useLayoutEffect(() => {
    releaseRef.current = release
  })
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [doubleClick, setDoubleClick] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const image = useRef<HTMLImageElement>(null)
  const start = useRef<{
    point: Point
    frame: Screenshot
    startedAt: number
    button: "left" | "middle" | "right"
  } | null>(null)

  useEffect(() => {
    start.current = null
  }, [connectionId, controlling, openDesktop])

  useEffect(() => {
    const element = image.current
    if (!element || !controlling || !frame) return
    const wheel = (event: WheelEvent) => {
      const point = framePoint(element, event.clientX, event.clientY, frame)
      if (!point) return
      event.preventDefault()
      // Browser wheel deltas may represent pixels, lines, or pages.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      void input(
        {
          kind: "scroll",
          opts: { dx: Math.round(event.deltaX * unit), dy: Math.round(event.deltaY * unit) },
        },
        point,
        frame.capturedAt
      )
    }
    // React delegates wheel handlers as passive listeners, so suppress native
    // sheet scrolling at the actual desktop surface instead.
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [controlling, frame, input])

  function pointerDown(event: PointerEvent<HTMLImageElement>) {
    if (!controlling || !frame) return
    event.preventDefault()
    event.currentTarget.focus()
    const point = framePoint(event.currentTarget, event.clientX, event.clientY, frame)
    if (!point) return
    start.current = {
      point,
      frame,
      startedAt: Date.now(),
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function pointerUp(event: PointerEvent<HTMLImageElement>) {
    const previous = start.current
    start.current = null
    if (
      !controlling ||
      !frame ||
      !previous ||
      Date.now() - previous.startedAt > 5_000 ||
      previous.frame.width !== frame.width ||
      previous.frame.height !== frame.height ||
      previous.frame.sourceWidth !== frame.sourceWidth ||
      previous.frame.sourceHeight !== frame.sourceHeight
    )
      return
    const point = framePoint(event.currentTarget, event.clientX, event.clientY, frame)
    if (!point) return
    const distance = Math.hypot(point.x - previous.point.x, point.y - previous.point.y)
    void input(
      distance > 4
        ? { kind: "drag", to: point, opts: { button: previous.button } }
        : { kind: "click", button: previous.button, count: doubleClick ? 2 : 1 },
      previous.point,
      frame.capturedAt
    )
  }

  function keyDown(event: KeyboardEvent<HTMLImageElement>) {
    if (
      !controlling ||
      !frame ||
      event.nativeEvent.isComposing ||
      ["Shift", "Control", "Alt", "Meta", "Dead", "Process", "Unidentified"].includes(event.key)
    )
      return
    // Escape always releases control locally, including when a remote app is hung.
    if (event.key === "Escape") {
      event.preventDefault()
      void release()
      return
    }
    event.preventDefault()
    const modifiers = [
      event.ctrlKey ? "ctrl" : "",
      event.altKey ? "alt" : "",
      event.metaKey ? "meta" : "",
      event.shiftKey ? "shift" : "",
    ].filter(Boolean)
    void input(
      event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
        ? { kind: "typeText", text: event.key }
        : {
            kind: "pressKey",
            chord: [
              ...modifiers,
              event.key === " " ? "Space" : event.key === "+" ? "Plus" : event.key,
            ].join("+"),
          },
      null,
      frame.capturedAt
    )
  }

  async function sendText() {
    if (!frame || !controlling || !text || sending) return
    const submitted = text
    setSending(true)
    try {
      if (await input({ kind: "typeText", text: submitted }, null, frame.capturedAt)) {
        setText((current) => (current === submitted ? "" : current))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="space-y-3" aria-label={t("title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <span className="text-xs text-muted-foreground" role="status">
          {controlling
            ? t("controlling")
            : status?.state === "quarantined"
              ? t("quarantined")
              : status?.controllerKind === "human"
                ? t("otherController")
                : t("readOnly")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {streaming ? t("streamCadence") : t("cadence")}
      </p>
      {openDesktop ? (
        <p className="text-xs text-muted-foreground" data-dormant="managed-desktop-agent-control">
          {t("agentDormant")}
        </p>
      ) : null}
      {mobileObservation ? (
        <p className="text-xs text-muted-foreground">{t("mobileObservation")}</p>
      ) : null}
      {status && !status.qualified ? (
        <p className="text-xs text-muted-foreground" data-dormant="managed-desktop-control">
          {t("qualificationRequired")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`error.${error}`)}
        </p>
      ) : null}
      {stream.grant ? (
        // Remounted per grant: a role change closes Selkies' socket anyway.
        <iframe
          key={stream.grant.url}
          src={stream.grant.url}
          title={t("streamTitle")}
          data-sandbox-stream={connectionId}
          data-stream-role={stream.grant.role}
          sandbox="allow-scripts allow-same-origin allow-pointer-lock"
          allow="fullscreen"
          referrerPolicy="no-referrer"
          className="block aspect-[16/10] w-full rounded border bg-black"
        />
      ) : frame ? (
        // Native img preserves the screenshot pixel aspect ratio for pointer mapping.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={image}
          src={`data:${screenshotMimeType(frame.format)};base64,${frame.bytes}`}
          alt={t("screen")}
          width={frame.width}
          height={frame.height}
          tabIndex={controlling ? 0 : -1}
          draggable={false}
          className={`block h-auto w-full rounded border outline-none focus-visible:ring-2 focus-visible:ring-ring ${controlling ? "touch-none cursor-crosshair" : ""}`}
          onPointerDown={pointerDown}
          onPointerUp={pointerUp}
          onPointerCancel={() => {
            start.current = null
          }}
          onContextMenu={(event) => {
            if (controlling) event.preventDefault()
          }}
          onKeyDown={keyDown}
        />
      ) : (
        <div className="rounded border p-6 text-center text-xs text-muted-foreground">
          {enabled ? (error ? t("disconnected") : t("loading")) : t("unavailable")}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!enabled} onClick={() => void refresh()}>
          {t("refresh")}
        </Button>
        <Button
          size="sm"
          disabled={
            !enabled ||
            !frame ||
            acquiring ||
            transferring ||
            mobileObservation ||
            (Boolean(openDesktop) && !controlling && !status?.canAcquire)
          }
          variant={controlling ? "secondary" : "outline"}
          onClick={() =>
            void (controlling
              ? release()
              : acquire(Boolean(openDesktop) || status?.controllerKind === "agent"))
          }
        >
          {acquiring ? t("acquiring") : controlling ? t("release") : t("takeControl")}
        </Button>
      </div>
      {controlling && streaming ? (
        <p className="text-xs text-muted-foreground">{t("streamControlHelp")}</p>
      ) : null}
      {controlling && !streaming ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("controlHelp")}</p>
          <Textarea
            aria-label={t("textLabel")}
            placeholder={t("textPlaceholder")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-pressed={doubleClick}
              onClick={() => setDoubleClick((value) => !value)}
            >
              {t("doubleClick")}
            </Button>
            <Button size="sm" disabled={!text || sending} onClick={() => void sendText()}>
              {t("sendText")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (frame) void input({ kind: "pressKey", chord: "Escape" }, null, frame.capturedAt)
              }}
            >
              {t("sendEscape")}
            </Button>
          </div>
        </div>
      ) : null}
      {!openDesktop ? (
        <SandboxFileTransfer
          key={`${connectionId}:${containerId ?? ""}`}
          connectionId={connectionId}
          containerId={containerId}
          enabled={enabled}
          releaseControl={release}
          onBusyChange={setTransferring}
        />
      ) : null}
    </section>
  )
}
