"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTheme } from "next-themes"
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock"

type MermaidProps = {
  chart: string
}

type Transform = {
  scale: number
  x: number
  y: number
}

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * Configure + render a chart to an SVG string. `renderId` must be unique per
 * live DOM instance: Mermaid emits internal `url(#id)` marker references, and
 * two SVGs sharing an id in the same document would break one set of arrowheads.
 */
async function renderChart(chart: string, renderId: string, dark: boolean): Promise<string> {
  const mermaid = (await import("mermaid")).default
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    securityLevel: "loose",
    themeVariables: {
      fontFamily: "var(--font-geist-sans, system-ui, sans-serif)",
    },
  })
  const { svg } = await mermaid.render(renderId, chart)
  return svg
}

function renderError(err: unknown): string {
  return `<pre style="color: var(--color-fd-destructive, #ef4444); white-space: pre-wrap; font-size: 0.875rem;">Mermaid render error:\n${
    err instanceof Error ? err.message : String(err)
  }</pre>`
}

export function Mermaid({ chart }: MermaidProps) {
  const id = useId().replace(/:/g, "")
  const inlineRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"

  // Standard "client-side hydration" gate — flip to `true` once on mount so the
  // server-rendered output stays untouched and dynamic-import + render happen
  // only on the client.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), [])

  // Inline (in-flow) render. Keeps Mermaid's responsive `max-width: 100%` SVG.
  useEffect(() => {
    if (!mounted || !inlineRef.current) return
    let cancelled = false

    void (async () => {
      try {
        const svg = await renderChart(chart, `mermaid-${id}`, dark)
        if (!cancelled && inlineRef.current) inlineRef.current.innerHTML = svg
      } catch (err) {
        if (!cancelled && inlineRef.current) inlineRef.current.innerHTML = renderError(err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [chart, id, mounted, dark])

  return (
    <>
      <figure className="group relative my-6">
        <div
          ref={inlineRef}
          className="flex justify-center overflow-x-auto rounded-lg border border-fd-border bg-fd-card p-4 [&_svg]:max-w-full"
        />
        <div className="pointer-events-none absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <ToolbarButton
            label="Expand diagram"
            onClick={() => setOpen(true)}
            className="pointer-events-auto"
          >
            <ExpandIcon />
          </ToolbarButton>
        </div>
      </figure>

      {mounted && open
        ? createPortal(
            <Lightbox
              chart={chart}
              dark={dark}
              renderId={`mermaid-${id}-zoom`}
              onClose={() => setOpen(false)}
            />,
            document.body
          )
        : null}
    </>
  )
}

type LightboxProps = {
  chart: string
  dark: boolean
  renderId: string
  onClose: () => void
}

function Lightbox({ chart, dark, renderId, onClose }: LightboxProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)

  const [transform, setTransform] = useState<Transform>(IDENTITY)
  const [dragging, setDragging] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [entered, setEntered] = useState(false)

  // Scale the rendered diagram to fit the canvas and center it. `offsetWidth`
  // ignores CSS transforms, so it always reports the diagram's natural size.
  const fit = useCallback(() => {
    const canvas = canvasRef.current
    const content = contentRef.current
    if (!canvas || !content) return
    const w = content.offsetWidth || 1
    const h = content.offsetHeight || 1
    const scale = clamp(
      Math.min(canvas.clientWidth / w, canvas.clientHeight / h) * 0.92,
      MIN_SCALE,
      MAX_SCALE
    )
    setTransform({
      scale,
      x: (canvas.clientWidth - w * scale) / 2,
      y: (canvas.clientHeight - h * scale) / 2,
    })
  }, [])

  // Render the diagram into the zoom canvas at its intrinsic size. Stripping the
  // responsive `max-width` and pinning width/height from the viewBox makes the
  // wrapper's `offsetWidth` deterministic so `fit()` can measure it.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    let cancelled = false

    void (async () => {
      try {
        const svg = await renderChart(chart, renderId, dark)
        if (cancelled || !contentRef.current) return
        contentRef.current.innerHTML = svg
        const svgEl = contentRef.current.querySelector("svg")
        if (svgEl) {
          const vb = svgEl
            .getAttribute("viewBox")
            ?.split(/[\s,]+/)
            .map(Number)
          if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            svgEl.style.maxWidth = "none"
            svgEl.style.width = `${vb[2]}px`
            svgEl.style.height = `${vb[3]}px`
          }
        }
        fit()
      } catch (err) {
        if (!cancelled && contentRef.current) contentRef.current.innerHTML = renderError(err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [chart, renderId, dark, fit])

  // Lock body scroll while open + play the enter transition on the next frame.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => {
      cancelAnimationFrame(raf)
      document.body.style.overflow = prev
    }
  }, [])

  // Zoom toward the canvas center by a multiplicative factor.
  const zoomBy = useCallback((factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cx = canvas.clientWidth / 2
    const cy = canvas.clientHeight / 2
    setTransform((prev) => {
      const scale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = scale / prev.scale
      return {
        scale,
        x: cx - ratio * (cx - prev.x),
        y: cy - ratio * (cy - prev.y),
      }
    })
  }, [])

  // Keyboard: Esc closes, +/- zoom, 0 resets to fit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
      else if (e.key === "+" || e.key === "=") zoomBy(1.2)
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2)
      else if (e.key === "0") fit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fit, onClose, zoomBy])

  // Wheel zoom anchored to the cursor (Feishu-board feel).
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    setTransform((prev) => {
      const scale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = scale / prev.scale
      return {
        scale,
        x: px - ratio * (px - prev.x),
        y: py - ratio * (py - prev.y),
      }
    })
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    drag.x = e.clientX
    drag.y = e.clientY
    setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Diagram viewer"
      className={`fixed inset-0 z-100 flex flex-col bg-black/70 backdrop-blur-sm transition-opacity duration-200 ${
        entered ? "opacity-100" : "opacity-0"
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex flex-1 overflow-hidden">
        {/* Pan/zoom canvas */}
        <div
          ref={canvasRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="relative flex-1 touch-none overflow-hidden"
          style={{ cursor: dragging ? "grabbing" : "grab" }}
        >
          <div
            ref={contentRef}
            className="absolute left-0 top-0 origin-top-left select-none [&_svg]:block"
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              transition: dragging ? "none" : "transform 120ms ease-out",
            }}
          />

          {/* Close button — pinned to the canvas (left of the code panel) so
              it never overlaps the panel's own controls. */}
          <ToolbarButton
            label="Close (Esc)"
            onClick={onClose}
            className="absolute right-4 top-4 h-9 w-9"
          >
            <CloseIcon />
          </ToolbarButton>
        </div>

        {/* Source-code side panel */}
        <aside
          className={`flex flex-col overflow-hidden border-l border-fd-border bg-fd-card transition-[width] duration-200 ${
            showCode ? "w-[min(28rem,42vw)]" : "w-0"
          }`}
        >
          {showCode ? (
            <>
              <div className="flex items-center border-b border-fd-border px-4 py-2.5">
                <span className="text-sm font-medium text-fd-foreground">Source</span>
              </div>
              <div className="flex-1 overflow-auto p-3 text-sm [&_figure]:my-0">
                <DynamicCodeBlock lang="mermaid" code={chart} />
              </div>
            </>
          ) : null}
        </aside>
      </div>

      {/* Floating zoom toolbar */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-fd-border bg-fd-card/95 p-1 shadow-lg backdrop-blur">
        <ToolbarButton
          label="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
          className="pointer-events-auto"
        >
          <MinusIcon />
        </ToolbarButton>
        <button
          type="button"
          onClick={fit}
          className="pointer-events-auto min-w-14 rounded-full px-2 py-1 text-center text-xs font-medium tabular-nums text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          aria-label="Reset zoom to fit"
        >
          {Math.round(transform.scale * 100)}%
        </button>
        <ToolbarButton label="Zoom in" onClick={() => zoomBy(1.2)} className="pointer-events-auto">
          <PlusIcon />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-fd-border" aria-hidden />
        <ToolbarButton label="Fit to screen" onClick={fit} className="pointer-events-auto">
          <FitIcon />
        </ToolbarButton>
        <ToolbarButton
          label={showCode ? "Hide source" : "View source"}
          onClick={() => setShowCode((v) => !v)}
          active={showCode}
          className="pointer-events-auto"
        >
          <CodeIcon />
        </ToolbarButton>
      </div>
    </div>
  )
}

type ToolbarButtonProps = {
  label: string
  onClick: () => void
  children: React.ReactNode
  className?: string
  active?: boolean
}

function ToolbarButton({ label, onClick, children, className, active }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`flex h-8 w-8 items-center justify-center rounded-full border border-fd-border bg-fd-card text-fd-muted-foreground shadow-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground ${
        active ? "bg-fd-accent text-fd-accent-foreground" : ""
      } ${className ?? ""}`}
    >
      {children}
    </button>
  )
}

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "h-4 w-4",
}

function ExpandIcon() {
  return (
    <svg {...iconProps}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg {...iconProps}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function MinusIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 12h14" />
    </svg>
  )
}

function FitIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

function CodeIcon() {
  return (
    <svg {...iconProps}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </svg>
  )
}
