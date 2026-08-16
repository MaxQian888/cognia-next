"use client"

import { useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react"

import { MatchHighlight } from "@/components/chat/completion/match-highlight"
import { findOccurrences } from "@/lib/chat/message-search"
import { cn } from "@/lib/utils"

import styles from "./hover-scroll-text.module.css"

const HOVER_DELAY_MS = 400
const PIXELS_PER_SECOND = 48
const MIN_DURATION_MS = 1_200
const MAX_DURATION_MS = 8_000

export interface HoverScrollTextProps {
  text: string
  className?: string
  /** `off` keeps the title static and exposes the complete value as a tooltip. */
  motion?: "hover" | "off"
  /**
   * Substring to emphasize (case-insensitive) — the active search query.
   * Rendering stays character-identical to the plain path, so the scroll
   * measurement below is unaffected; only the matched runs gain a `<mark>`.
   */
  highlight?: string
}

interface ScrollMotion {
  text: string
  distance: number
  contentWidth: number
  duration: number
  delay: number
}

type ScrollStyle = CSSProperties & {
  "--hover-scroll-distance": string
  "--hover-scroll-content-width": string
  "--hover-scroll-duration": string
  "--hover-scroll-delay": string
  "--hover-scroll-cycle-duration": string
}

function prefersReducedMotion(): boolean {
  const root = document.documentElement
  return (
    root.classList.contains("reduce-motion") ||
    root.dataset.reduceMotion === "true" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  )
}

function readDurationScale(): number {
  const rawScale = getComputedStyle(document.documentElement).getPropertyValue(
    "--motion-duration-scale"
  )
  const scale = Number.parseFloat(rawScale)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

export function HoverScrollText({
  text,
  className,
  motion: motionMode = "hover",
  highlight,
}: HoverScrollTextProps) {
  const contentRef = useRef<HTMLSpanElement>(null)
  const [motion, setMotion] = useState<ScrollMotion | null>(null)
  const [showStaticTitle, setShowStaticTitle] = useState(false)
  const activeMotion = motion?.text === text ? motion : null

  // Character indices of every occurrence of the search term. Computed here
  // rather than by the row so the (potentially long) title is walked once per
  // title/query change instead of on every parent render.
  const highlightPositions = useMemo(() => {
    const needle = highlight?.trim().toLowerCase()
    if (!needle) return null
    const starts = findOccurrences(text.toLowerCase(), needle)
    if (starts.length === 0) return null
    const positions: number[] = []
    for (const start of starts) {
      for (let offset = 0; offset < needle.length; offset++) positions.push(start + offset)
    }
    return positions
  }, [highlight, text])

  const handleMouseEnter = (event: MouseEvent<HTMLSpanElement>) => {
    if (motionMode === "off" || prefersReducedMotion()) {
      setShowStaticTitle(true)
      return
    }

    const content = contentRef.current
    if (!content) return

    const contentWidth = content.scrollWidth
    const distance = Math.ceil(contentWidth - event.currentTarget.clientWidth)
    if (distance <= 1) return

    const baseDuration = Math.min(
      MAX_DURATION_MS,
      Math.max(MIN_DURATION_MS, Math.round((distance / PIXELS_PER_SECOND) * 1_000))
    )
    const durationScale = readDurationScale()
    setMotion({
      text,
      distance,
      contentWidth,
      duration: Math.round(baseDuration * durationScale),
      delay: Math.round(HOVER_DELAY_MS * durationScale),
    })
  }

  const scrollStyle: ScrollStyle | undefined = activeMotion
    ? {
        "--hover-scroll-distance": `-${activeMotion.distance}px`,
        "--hover-scroll-content-width": `${activeMotion.contentWidth}px`,
        "--hover-scroll-duration": `${activeMotion.duration}ms`,
        "--hover-scroll-delay": `${activeMotion.delay}ms`,
        "--hover-scroll-cycle-duration": `${activeMotion.duration * 2 + activeMotion.delay * 2}ms`,
      }
    : undefined

  return (
    <span
      className={cn("block min-w-0 overflow-hidden", className)}
      data-slot="hover-scroll-text"
      data-motion={motionMode}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => {
        setMotion(null)
        setShowStaticTitle(false)
      }}
      title={showStaticTitle ? text : undefined}
    >
      <span
        ref={contentRef}
        className={cn(
          "block",
          activeMotion ? cn("whitespace-nowrap", styles.scrolling) : "truncate"
        )}
        data-scrolling={activeMotion ? "true" : undefined}
        style={scrollStyle}
      >
        {highlightPositions ? (
          <MatchHighlight
            text={text}
            positions={highlightPositions}
            markClassName="rounded-[2px] bg-primary/20 font-semibold text-foreground"
          />
        ) : (
          text
        )}
      </span>
    </span>
  )
}
