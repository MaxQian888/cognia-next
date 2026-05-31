"use client"

/**
 * Lightweight SVG dependency-graph renderer. Nodes are absolutely-positioned
 * buttons laid out in topological columns (level → column, stacked + centered
 * per column); edges are cubic-bezier SVG paths drawn in an overlay. Geometry
 * is computed deterministically from the {@link DependencyGraph} (no DOM
 * measurement), so it renders identically in tests and in the browser.
 *
 * Deliberately not React Flow: this is a read-only, mostly-static DAG, so a few
 * hundred lines of SVG beat a ~120KB canvas with pan/zoom/handles.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"
import type { DependencyGraph } from "@/types/scheduler/dependency"
import { graphNodeVariants, listContainerVariants, staticIf } from "./scheduler-motion"

const NODE_W = 150
const NODE_H = 46
const COL_GAP = 56
const ROW_GAP = 14
const PAD = 8

export interface TaskDependencyGraphProps {
  graph: DependencyGraph
  /** Highlighted node (the task whose detail view is open). */
  focusTaskId?: string
  onSelectTask: (taskId: string) => void
  className?: string
}

interface Placed {
  id: string
  name: string
  inCycle: boolean
  x: number
  y: number
}

export function TaskDependencyGraph({
  graph,
  focusTaskId,
  onSelectTask,
  className,
}: TaskDependencyGraphProps) {
  const t = useTranslations("scheduler.dependencyGraph")
  const prefersReduced = useReducedMotion()

  const { placed, width, height } = useMemo(() => layout(graph), [graph])
  const posById = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed])

  if (graph.nodes.length === 0) {
    return (
      <p
        data-testid="dependency-graph-empty"
        className={cn("py-6 text-center text-xs text-muted-foreground", className)}
      >
        {t("empty")}
      </p>
    )
  }

  return (
    <div className={cn("space-y-2", className)} data-testid="task-dependency-graph">
      {graph.hasCycle && (
        <p
          className="flex items-center gap-1.5 text-xs text-red-500"
          data-testid="dependency-cycle-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("cycleWarning")}
        </p>
      )}
      <div
        className="relative"
        style={{ width: width + PAD * 2, height: height + PAD * 2 }}
        role="group"
      >
        {/* Edge overlay */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={width + PAD * 2}
          height={height + PAD * 2}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="dep-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground/60" />
            </marker>
            <marker
              id="dep-arrow-cycle"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" className="fill-red-500" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const a = posById.get(edge.from)
            const b = posById.get(edge.to)
            if (!a || !b) return null
            const x1 = a.x + NODE_W + PAD
            const y1 = a.y + NODE_H / 2 + PAD
            const x2 = b.x + PAD
            const y2 = b.y + NODE_H / 2 + PAD
            const midX = (x1 + x2) / 2
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                fill="none"
                strokeWidth={1.5}
                className={edge.inCycle ? "stroke-red-500" : "stroke-muted-foreground/50"}
                markerEnd={`url(#${edge.inCycle ? "dep-arrow-cycle" : "dep-arrow"})`}
                data-testid={`dependency-edge-${edge.from}-${edge.to}`}
              />
            )
          })}
        </svg>

        {/* Nodes */}
        <motion.div
          variants={staticIf(prefersReduced, listContainerVariants)}
          initial="hidden"
          animate="show"
        >
          {placed.map((p) => {
            const isFocus = p.id === focusTaskId
            return (
              <motion.button
                key={p.id}
                type="button"
                variants={graphNodeVariants}
                onClick={() => onSelectTask(p.id)}
                aria-label={t("nodeAria", { name: p.name })}
                data-testid={`dependency-node-${p.id}`}
                style={{ left: p.x + PAD, top: p.y + PAD, width: NODE_W, height: NODE_H }}
                className={cn(
                  "absolute flex items-center gap-2 rounded-lg border bg-card px-2.5 text-left transition-colors hover:bg-accent",
                  p.inCycle
                    ? "border-red-500/60"
                    : isFocus
                      ? "border-primary ring-1 ring-primary/40"
                      : "border-border/70"
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    p.inCycle ? "bg-red-500" : "bg-green-500"
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{p.name}</span>
              </motion.button>
            )
          })}
        </motion.div>
      </div>
    </div>
  )
}

/** Deterministic columnar layout (level = column, centered vertically). */
function layout(graph: DependencyGraph): { placed: Placed[]; width: number; height: number } {
  const columns: DependencyGraph["nodes"][] = Array.from({ length: graph.levelCount }, () => [])
  for (const node of graph.nodes) {
    const col = columns[node.level] ?? columns[0]
    if (col) col.push(node)
  }

  const colHeight = (count: number) => count * NODE_H + Math.max(0, count - 1) * ROW_GAP
  const maxRows = columns.reduce((m, c) => Math.max(m, c.length), 0)
  const height = colHeight(maxRows)
  const width =
    graph.levelCount > 0 ? graph.levelCount * NODE_W + (graph.levelCount - 1) * COL_GAP : 0

  const placed: Placed[] = []
  columns.forEach((col, level) => {
    const ch = colHeight(col.length)
    const yStart = (height - ch) / 2
    col.forEach((node, row) => {
      placed.push({
        id: node.id,
        name: node.name,
        inCycle: node.inCycle,
        x: level * (NODE_W + COL_GAP),
        y: yStart + row * (NODE_H + ROW_GAP),
      })
    })
  })

  return { placed, width, height }
}
