"use client"

import { forwardRef, useRef } from "react"
import { useReducedMotion } from "motion/react"

import { AnimatedBeam } from "@web/components/ui/animated-beam"
import type { ConnectionFlowCopy } from "@web/content/types"

interface ConnectionFlowProps {
  copy: ConnectionFlowCopy
  /** Labels for the source nodes, derived from connection items. */
  nodeLabels: string[]
  approvalLabel?: string
  activeIndex?: number | null
  onActiveIndexChange?: (index: number | null) => void
}

interface SourceNodeProps {
  label: string
  index: number
  active: boolean
  onActiveIndexChange?: (index: number | null) => void
}

const SourceNode = forwardRef<HTMLButtonElement, SourceNodeProps>(
  ({ label, index, active, onActiveIndexChange }, ref) => (
    <button
      ref={ref}
      type="button"
      data-active={active ? "true" : undefined}
      onFocus={() => onActiveIndexChange?.(index)}
      onBlur={() => onActiveIndexChange?.(null)}
      onMouseEnter={() => onActiveIndexChange?.(index)}
      onMouseLeave={() => onActiveIndexChange?.(null)}
      className="relative z-10 flex w-full items-center gap-2 border-b border-hairline bg-surface px-2 py-2 text-left text-xs font-medium text-ink transition-colors data-[active=true]:bg-paper"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-action" />
      {label}
    </button>
  )
)

SourceNode.displayName = "SourceNode"

/**
 * An animated beam diagram showing how Cognia connects to external systems.
 *
 * Layout: 4 source nodes flow into 1 center node via curved beams.
 * Finite animation (repeat: 2), then static.
 * Reduced motion: static SVG lines, no animation.
 * Mobile (< md): stacked vertical layout with simple connectors.
 */
export function ConnectionFlow({
  copy,
  nodeLabels,
  approvalLabel,
  activeIndex = null,
  onActiveIndexChange,
}: ConnectionFlowProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const centerRef = useRef<HTMLDivElement>(null)
  const approvalRef = useRef<HTMLDivElement>(null)
  const firstNodeRef = useRef<HTMLButtonElement>(null)
  const secondNodeRef = useRef<HTMLButtonElement>(null)
  const thirdNodeRef = useRef<HTMLButtonElement>(null)
  const fourthNodeRef = useRef<HTMLButtonElement>(null)
  const reduced = useReducedMotion()

  return (
    <div
      ref={containerRef}
      className="relative isolate grid min-h-56 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-8 overflow-hidden border-y border-hairline py-6 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:px-6"
      role="group"
      aria-label={copy.label}
    >
      {/* Source nodes - left side */}
      <div className="flex flex-col items-start justify-between gap-4 md:gap-6">
        {nodeLabels[0] ? (
          <SourceNode
            ref={firstNodeRef}
            label={nodeLabels[0]}
            index={0}
            active={activeIndex === 0}
            onActiveIndexChange={onActiveIndexChange}
          />
        ) : null}
        {nodeLabels[1] ? (
          <SourceNode
            ref={secondNodeRef}
            label={nodeLabels[1]}
            index={1}
            active={activeIndex === 1}
            onActiveIndexChange={onActiveIndexChange}
          />
        ) : null}
        {nodeLabels[2] ? (
          <SourceNode
            ref={thirdNodeRef}
            label={nodeLabels[2]}
            index={2}
            active={activeIndex === 2}
            onActiveIndexChange={onActiveIndexChange}
          />
        ) : null}
        {nodeLabels[3] ? (
          <SourceNode
            ref={fourthNodeRef}
            label={nodeLabels[3]}
            index={3}
            active={activeIndex === 3}
            onActiveIndexChange={onActiveIndexChange}
          />
        ) : null}
      </div>

      {/* Center node */}
      <div
        ref={centerRef}
        className="relative z-10 flex items-center gap-2 border-y border-action/60 bg-surface px-4 py-3 text-sm font-semibold text-ink"
      >
        <span aria-hidden className="size-2 rounded-full bg-action" />
        {copy.centerNode}
      </div>

      {approvalLabel ? (
        <div
          ref={approvalRef}
          className="relative z-10 col-span-2 flex items-center justify-end gap-2 border-b border-approval/60 bg-surface px-2 py-2 text-xs font-medium text-ink md:col-span-1 md:justify-start"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-approval" />
          {approvalLabel}
        </div>
      ) : null}

      {/* Animated beams (hidden on reduced motion) */}
      {!reduced ? (
        <>
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={firstNodeRef}
            toRef={centerRef}
            curvature={30}
            pathColor="var(--hairline)"
            gradientStartColor="var(--action)"
            gradientStopColor="var(--action)"
            pathOpacity={0.55}
            pathWidth={1.5}
            duration={4}
            delay={0}
            repeat={2}
          />
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={secondNodeRef}
            toRef={centerRef}
            curvature={-30}
            pathColor="var(--hairline)"
            gradientStartColor="var(--action)"
            gradientStopColor="var(--action)"
            pathOpacity={0.55}
            pathWidth={1.5}
            duration={4}
            delay={0.5}
            repeat={2}
          />
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={thirdNodeRef}
            toRef={centerRef}
            curvature={30}
            pathColor="var(--hairline)"
            gradientStartColor="var(--action)"
            gradientStopColor="var(--action)"
            pathOpacity={0.55}
            pathWidth={1.5}
            duration={4}
            delay={1}
            repeat={2}
          />
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={fourthNodeRef}
            toRef={centerRef}
            curvature={-30}
            pathColor="var(--hairline)"
            gradientStartColor="var(--action)"
            gradientStopColor="var(--action)"
            pathOpacity={0.55}
            pathWidth={1.5}
            duration={4}
            delay={1.5}
            repeat={2}
          />
        </>
      ) : null}

      {!reduced && approvalLabel ? (
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={centerRef}
          toRef={approvalRef}
          pathColor="var(--hairline)"
          gradientStartColor="var(--approval)"
          gradientStopColor="var(--approval)"
          pathOpacity={0.55}
          pathWidth={1.5}
          duration={4}
          delay={1}
          repeat={2}
        />
      ) : null}

      {/* Static connectors for reduced motion */}
      {reduced && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          {/* Simple horizontal lines from each node area to center */}
          <line x1="30%" y1="20%" x2="70%" y2="50%" stroke="var(--hairline)" strokeWidth="1.5" />
          <line x1="30%" y1="40%" x2="70%" y2="50%" stroke="var(--hairline)" strokeWidth="1.5" />
          <line x1="30%" y1="60%" x2="70%" y2="50%" stroke="var(--hairline)" strokeWidth="1.5" />
          <line x1="30%" y1="80%" x2="70%" y2="50%" stroke="var(--hairline)" strokeWidth="1.5" />
          {approvalLabel ? (
            <line x1="70%" y1="50%" x2="92%" y2="50%" stroke="var(--approval)" strokeWidth="1.5" />
          ) : null}
        </svg>
      )}
    </div>
  )
}
