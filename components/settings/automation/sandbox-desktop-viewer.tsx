"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useSandboxDesktop } from "@/hooks/automation/use-sandbox-desktop"
import { screenshotMimeType } from "@/lib/automation/model-frame"
import type { Point, Screenshot } from "@/lib/automation/types"
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

/** Screenshots stay inside the authenticated command transport; no raw desktop endpoint is exposed. */
export function SandboxDesktopViewer({
  connectionId,
  enabled,
  containerId,
}: {
  connectionId: string
  enabled: boolean
  containerId?: string
}) {
  const t = useTranslations("automation.sandboxConnections.desktopViewer")
  const { frame, controlling, acquiring, error, acquire, release, refresh, input } =
    useSandboxDesktop(connectionId, enabled)
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
  }, [connectionId, controlling])

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
          {controlling ? t("controlling") : t("readOnly")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("cadence")}</p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`error.${error}`)}
        </p>
      ) : null}
      {frame ? (
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
          disabled={!enabled || !frame || acquiring || transferring}
          variant={controlling ? "secondary" : "outline"}
          onClick={() => void (controlling ? release() : acquire())}
        >
          {acquiring ? t("acquiring") : controlling ? t("release") : t("takeControl")}
        </Button>
      </div>
      {controlling ? (
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
      <SandboxFileTransfer
        key={`${connectionId}:${containerId ?? ""}`}
        connectionId={connectionId}
        containerId={containerId}
        enabled={enabled}
        releaseControl={release}
        onBusyChange={setTransferring}
      />
    </section>
  )
}
