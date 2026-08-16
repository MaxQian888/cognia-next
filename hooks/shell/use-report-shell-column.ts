"use client"

/**
 * Publish a column's rendered width to `useShellColumnsStore` for as long as
 * the element is mounted, and zero it on unmount.
 *
 * Built on `useElementWidth` so the measurement is taken before paint on mount
 * and on every ResizeObserver tick after — the same clock the column's own
 * width animation runs on, so the title-bar zone above it never lags a frame.
 */

import { useEffect, type RefObject } from "react"
import { useElementWidth } from "@/hooks/use-element-width"
import { useShellColumnsStore, type ShellColumn } from "@/stores/ui/shell-columns-store"

export function useReportShellColumn(
  column: ShellColumn,
  ref: RefObject<HTMLElement | null>
): void {
  const width = useElementWidth(ref)
  const setColumnWidth = useShellColumnsStore((s) => s.setColumnWidth)

  useEffect(() => {
    setColumnWidth(column, width)
  }, [column, setColumnWidth, width])

  useEffect(() => {
    return () => setColumnWidth(column, 0)
  }, [column, setColumnWidth])
}
