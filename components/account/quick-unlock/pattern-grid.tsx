"use client"

// The 3x3 pattern grid.
//
// Two input modes, both first-class rather than one being an afterthought:
//
//   - POINTER: press and drag across nodes. Pointer Events are used directly
//     (not mouse plus touch) so one code path covers finger, pen and mouse,
//     and `setPointerCapture` keeps the stroke alive when the finger leaves
//     the element, which on a phone happens constantly near the edges.
//   - KEYBOARD: each node is a real button. Tab or arrow to one and press it
//     to append. A pattern lock that can only be drawn is a pattern lock that
//     locks out anyone who cannot drag, which is not an acceptable way to
//     gate someone's own account.
//
// The connecting line is drawn in SVG under the nodes so the stroke reads as
// one gesture rather than a set of lit dots.

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MAX_PATTERN_LENGTH, MIN_PATTERN_LENGTH } from "@/lib/accounts/quick-unlock/types"

export interface PatternGridProps {
  onSubmit: (nodes: number[]) => void
  disabled?: boolean
  error?: string | null
  hint?: string
  submitLabel?: string
  testIdPrefix?: string
}

/** Node centres in a 0..100 viewBox, in reading order. */
const NODES = [
  { x: 20, y: 20 },
  { x: 50, y: 20 },
  { x: 80, y: 20 },
  { x: 20, y: 50 },
  { x: 50, y: 50 },
  { x: 80, y: 50 },
  { x: 20, y: 80 },
  { x: 50, y: 80 },
  { x: 80, y: 80 },
]

export function PatternGrid({
  onSubmit,
  disabled = false,
  error = null,
  hint,
  submitLabel,
  testIdPrefix = "pattern",
}: PatternGridProps) {
  const t = useTranslations("account.quickUnlock.pattern")
  const [nodes, setNodes] = useState<number[]>([])
  const [drawing, setDrawing] = useState(false)
  const surfaceRef = useRef<HTMLDivElement>(null)

  const canSubmit = nodes.length >= MIN_PATTERN_LENGTH && !disabled

  const appendNode = useCallback(
    (index: number) => {
      if (disabled) return
      setNodes((current) => {
        // A node already in the stroke is skipped rather than restarting the
        // pattern. Crossing back over one is a normal thing a finger does.
        if (current.includes(index)) return current
        if (current.length >= MAX_PATTERN_LENGTH) return current
        return [...current, index]
      })
    },
    [disabled]
  )

  /** Which node, if any, sits under a client point. */
  const nodeAtPoint = useCallback((clientX: number, clientY: number): number | null => {
    const surface = surfaceRef.current
    if (!surface) return null
    const rect = surface.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const x = ((clientX - rect.left) / rect.width) * 100
    const y = ((clientY - rect.top) / rect.height) * 100
    for (const [index, node] of NODES.entries()) {
      const dx = x - node.x
      const dy = y - node.y
      // A generous radius: the visible dot is small, but the target a finger
      // aims at is the whole cell.
      if (dx * dx + dy * dy <= 13 * 13) return index
    }
    return null
  }, [])

  const submit = () => {
    if (nodes.length < MIN_PATTERN_LENGTH) return
    onSubmit(nodes)
    setNodes([])
  }

  return (
    <div
      className="flex flex-col items-center gap-4"
      data-testid={`${testIdPrefix}-grid`}
      role="group"
      aria-label={t("label")}
    >
      <div
        ref={surfaceRef}
        className={cn(
          "relative aspect-square w-56 touch-none select-none",
          error && "motion-safe:animate-[cognia-shake_320ms_ease-in-out]",
          disabled && "opacity-50"
        )}
        onPointerDown={(event) => {
          if (disabled) return
          // Capture on the surface, so a finger that slides past the edge keeps
          // feeding this element instead of silently ending the stroke.
          event.currentTarget.setPointerCapture(event.pointerId)
          setNodes([])
          setDrawing(true)
          const index = nodeAtPoint(event.clientX, event.clientY)
          if (index !== null) appendNode(index)
        }}
        onPointerMove={(event) => {
          if (!drawing || disabled) return
          const index = nodeAtPoint(event.clientX, event.clientY)
          if (index !== null) appendNode(index)
        }}
        onPointerUp={() => setDrawing(false)}
        onPointerCancel={() => setDrawing(false)}
        data-testid={`${testIdPrefix}-surface`}
      >
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden="true">
          {nodes.slice(1).map((node, i) => {
            const from = NODES[nodes[i]]
            const to = NODES[node]
            return (
              <line
                key={`${nodes[i]}-${node}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className="stroke-primary"
                strokeWidth={2}
                strokeLinecap="round"
              />
            )
          })}
        </svg>

        <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
          {NODES.map((_, index) => {
            const order = nodes.indexOf(index)
            const selected = order >= 0
            return (
              <button
                key={index}
                type="button"
                disabled={disabled}
                // Keyboard parity with the drag gesture. Without this the
                // pattern is unreachable for anyone who cannot drag.
                onClick={() => appendNode(index)}
                className="flex items-center justify-center outline-none"
                aria-label={t("node", { index: index + 1 })}
                aria-pressed={selected}
                data-testid={`${testIdPrefix}-node-${index}`}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-medium transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40"
                  )}
                >
                  {selected ? order + 1 : ""}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("progress", { count: nodes.length, min: MIN_PATTERN_LENGTH })}
        </p>
      )}

      <div className="flex w-full gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={disabled || nodes.length === 0}
          onClick={() => setNodes([])}
          data-testid={`${testIdPrefix}-clear`}
        >
          {t("clear")}
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={!canSubmit}
          onClick={submit}
          data-testid={`${testIdPrefix}-submit`}
        >
          {submitLabel ?? t("submit")}
        </Button>
      </div>
    </div>
  )
}
