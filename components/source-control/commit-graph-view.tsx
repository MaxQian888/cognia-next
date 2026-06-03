"use client"

/**
 * CommitGraphView — renders the pure `assignLanes` layout as a GitKraken-style
 * branch graph. Each row is a fixed-height flex row: a self-contained SVG cell
 * on the left (lane edges + the commit node) and the commit summary + ref
 * badges on the right. Lane colors come from the shared theme palette.
 *
 * Self-contained rows (no cross-row SVG) keep this cheap; the Timeline pages at
 * 50 commits so a plain map is fine — if histories grow unbounded, drop in a
 * windowing list here without touching the layout engine.
 */

import { useMemo } from "react"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { resolveGraphPalette } from "@/lib/git/lane-palette"
import { assignLanes } from "@/lib/git/commit-graph"
import { cn } from "@/lib/utils"
import type { GitCommit, GitRef } from "@/types/git"

const ROW_H = 30
const LANE_W = 14
const NODE_R = 4

interface CommitGraphViewProps {
  commits: GitCommit[]
  refs: GitRef[]
  selectedCommit: string | null
  onSelect: (hash: string) => void
}

function laneCenter(lane: number): number {
  return lane * LANE_W + LANE_W / 2
}

export function CommitGraphView({ commits, refs, selectedCommit, onSelect }: CommitGraphViewProps) {
  const colors = useThemeColors()
  const palette = useMemo(() => resolveGraphPalette(colors), [colors])
  const layout = useMemo(() => assignLanes(commits, refs), [commits, refs])

  const cellWidth = Math.max(1, layout.laneCount) * LANE_W
  const paletteColor = (i: number) =>
    palette[((i % palette.length) + palette.length) % palette.length]

  return (
    <ul className="flex flex-col p-1" data-testid="commit-graph">
      {layout.rows.map((row) => (
        <li key={row.commit.hash}>
          <button
            type="button"
            onClick={() => onSelect(row.commit.hash)}
            className={cn(
              "flex w-full items-stretch gap-2 rounded text-left hover:bg-accent",
              selectedCommit === row.commit.hash && "bg-accent"
            )}
            data-testid={`graph-commit-${row.commit.hash}`}
          >
            <svg
              width={cellWidth}
              height={ROW_H}
              className="shrink-0"
              aria-hidden="true"
              style={{ minWidth: cellWidth }}
            >
              {row.edges.map((edge, i) => {
                const x1 = laneCenter(edge.fromLane)
                const x2 = laneCenter(edge.toLane)
                const stroke = paletteColor(edge.color)
                return x1 === x2 ? (
                  <line
                    key={i}
                    x1={x1}
                    y1={0}
                    x2={x2}
                    y2={ROW_H}
                    stroke={stroke}
                    strokeWidth={1.5}
                  />
                ) : (
                  <path
                    key={i}
                    d={`M${x1},0 C${x1},${ROW_H / 2} ${x2},${ROW_H / 2} ${x2},${ROW_H}`}
                    stroke={stroke}
                    strokeWidth={1.5}
                    fill="none"
                  />
                )
              })}
              <circle
                cx={laneCenter(row.lane)}
                cy={ROW_H / 2}
                r={NODE_R}
                fill={paletteColor(row.color)}
                stroke="var(--background)"
                strokeWidth={1.5}
              />
            </svg>

            <span className="flex min-w-0 flex-1 flex-col justify-center py-1">
              <span className="flex items-center gap-1">
                {row.refs.map((ref) => (
                  <span
                    key={`${ref.kind}:${ref.name}`}
                    className={cn(
                      "shrink-0 rounded px-1 py-px text-[9px] font-medium",
                      ref.kind === "tag"
                        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                        : "bg-primary/15 text-primary"
                    )}
                    data-testid={`graph-ref-${ref.name}`}
                  >
                    {ref.name}
                  </span>
                ))}
                <span className="line-clamp-1 text-sm">{row.commit.summary}</span>
              </span>
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{row.commit.shortHash}</span>
                <span className="truncate">{row.commit.authorName}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
