"use client"

import { forwardRef, useRef } from "react"
import { useReducedMotion } from "motion/react"

import { BrandMark } from "@web/components/brand-mark"
import { Icon, type IconName } from "@web/components/icon"
import { AnimatedBeam } from "@web/components/ui/animated-beam"
import type { ConnectionFlowCopy } from "@web/content/types"
import { cn } from "@web/lib/utils"

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

/**
 * One mark per source, by position. The four connections are a fixed set in
 * the copy (repository, MCP tool, plugin, chat) and carry no key to index by.
 */
const SOURCE_ICON: IconName[] = ["repository", "tool", "plugin", "chat"]

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
      className={cn(
        "relative z-10 flex w-full max-w-64 items-center gap-2.5 rounded-control border bg-surface px-3 py-2.5 text-left text-xs font-medium text-ink transition-colors",
        active ? "border-action" : "border-hairline-strong hover:border-action/60"
      )}
    >
      <Icon name={SOURCE_ICON[index] ?? "tool"} size={14} className="text-muted" />
      {label}
      <span
        aria-hidden
        className={cn(
          "ml-auto size-1.5 rounded-full transition-colors",
          active ? "bg-action" : "bg-hairline-strong"
        )}
      />
    </button>
  )
)

SourceNode.displayName = "SourceNode"

const BEAM = {
  pathColor: "var(--hairline-strong)",
  pathOpacity: 0.7,
  pathWidth: 1.5,
  duration: 4,
  repeat: 2,
} as const

/**
 * How the four connections reach the workbench, and where the approval
 * boundary sits on the way out.
 *
 * Three columns that the content, not the shell, sizes: the sources stacked
 * on the left, the workbench as the one node in the middle, the approval
 * checkpoint on the right. The earlier version let the right column stretch
 * to the shell edge, so the checkpoint became a rule across half the page and
 * the beams met it at a shallow, arbitrary angle. Capping the diagram's width
 * and centring it keeps every path short enough to read as a connection.
 *
 * Finite animation (two passes), then static. Reduced motion renders the same
 * nodes joined by plain lines. Below `md` the sources stack above the
 * workbench and the beams still find them, because the paths are measured
 * from the live layout rather than drawn by hand.
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
      role="group"
      aria-label={copy.label}
      className="relative isolate mx-auto grid w-full max-w-5xl grid-cols-1 items-center gap-10 overflow-hidden rounded-stage border border-hairline bg-paper px-6 py-8 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,16rem)] md:gap-12 md:px-10 md:py-10"
    >
      <div aria-hidden className="rhythm-lines pointer-events-none absolute inset-0 opacity-40" />

      {/* Source nodes */}
      <div className="relative flex flex-col items-start gap-3 md:gap-4">
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

      {/* The workbench */}
      <div className="relative flex justify-center">
        <div
          ref={centerRef}
          className="relative z-10 flex items-center gap-3 rounded-panel border border-action/70 bg-surface px-5 py-4 text-sm font-medium text-ink"
        >
          <BrandMark className="text-ink" size={18} />
          {copy.centerNode}
        </div>
      </div>

      {approvalLabel ? (
        <div className="relative flex md:justify-start">
          <div
            ref={approvalRef}
            className="relative z-10 flex items-center gap-2.5 rounded-control border border-approval/70 bg-surface px-3 py-2.5 text-xs font-medium text-ink"
          >
            <Icon name="approval" size={14} className="text-approval" />
            {approvalLabel}
            <span aria-hidden className="ml-1 size-1.5 rounded-full bg-approval" />
          </div>
        </div>
      ) : null}

      {/* Live beams, one per source. Written out rather than mapped over the
       * ref array: the compiler's rule cannot tell a ref passed through a
       * callback from a ref read during render, and four lines is cheaper than
       * a suppression. Hidden under reduced motion, where the static lines
       * below carry the same topology. */}
      {!reduced && nodeLabels[0] ? (
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={firstNodeRef}
          toRef={centerRef}
          curvature={24}
          gradientStartColor="var(--action)"
          gradientStopColor="var(--action)"
          delay={0}
          {...BEAM}
        />
      ) : null}
      {!reduced && nodeLabels[1] ? (
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={secondNodeRef}
          toRef={centerRef}
          curvature={-24}
          gradientStartColor="var(--action)"
          gradientStopColor="var(--action)"
          delay={0.4}
          {...BEAM}
        />
      ) : null}
      {!reduced && nodeLabels[2] ? (
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={thirdNodeRef}
          toRef={centerRef}
          curvature={24}
          gradientStartColor="var(--action)"
          gradientStopColor="var(--action)"
          delay={0.8}
          {...BEAM}
        />
      ) : null}
      {!reduced && nodeLabels[3] ? (
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={fourthNodeRef}
          toRef={centerRef}
          curvature={-24}
          gradientStartColor="var(--action)"
          gradientStopColor="var(--action)"
          delay={1.2}
          {...BEAM}
        />
      ) : null}

      {!reduced && approvalLabel ? (
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={centerRef}
          toRef={approvalRef}
          gradientStartColor="var(--approval)"
          gradientStopColor="var(--approval)"
          delay={1.6}
          {...BEAM}
        />
      ) : null}

      {reduced ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          {[14, 38, 62, 86].slice(0, Math.min(nodeLabels.length, 4)).map((y) => (
            <line
              key={y}
              x1="26%"
              y1={`${y}%`}
              x2="50%"
              y2="50%"
              stroke="var(--hairline-strong)"
              strokeWidth="1.5"
            />
          ))}
          {approvalLabel ? (
            <line x1="50%" y1="50%" x2="74%" y2="50%" stroke="var(--approval)" strokeWidth="1.5" />
          ) : null}
        </svg>
      ) : null}
    </div>
  )
}
