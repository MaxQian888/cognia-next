"use client"

/**
 * Publish a column's rendered width to `useShellColumnsStore` for as long as
 * the element is mounted, and zero it on unmount.
 *
 * Built on `useElementWidth` so the measurement is taken before paint on mount
 * and on every ResizeObserver tick after — the same clock the column's own
 * width animation runs on, so the title-bar zone above it never lags a frame.
 *
 * `target` is the width the column is animating *toward* during an edge-panel
 * gesture (`useEdgePanelTransition`), or `null` at rest. A live measurement
 * is only honest about where the column *is*; under a View Transition the DOM
 * reaches the resting width in one frame, so the outlets would snap to it
 * while the snapshot below is still sliding. The target lets the bar move its
 * outlets on the same clock the column moves on. It publishes in a layout
 * effect — the commit that starts the gesture must carry it before paint, or
 * the outlets learn the destination a frame late and jump to catch up.
 */

import { useEffect, type RefObject } from "react"
import { useElementWidth } from "@/hooks/use-element-width"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { useShellColumnsStore, type ShellColumn } from "@/stores/ui/shell-columns-store"

export function useReportShellColumn(
  column: ShellColumn,
  ref: RefObject<HTMLElement | null>,
  target: number | null = null
): number {
  const width = useElementWidth(ref)
  const setColumnWidth = useShellColumnsStore((s) => s.setColumnWidth)
  const setColumnTarget = useShellColumnsStore((s) => s.setColumnTarget)

  useEffect(() => {
    setColumnWidth(column, width)
  }, [column, setColumnWidth, width])

  useIsomorphicLayoutEffect(() => {
    setColumnTarget(column, target)
  }, [column, setColumnTarget, target])

  useEffect(() => {
    return () => {
      setColumnWidth(column, 0)
      setColumnTarget(column, null)
    }
  }, [column, setColumnWidth, setColumnTarget])

  return width
}
