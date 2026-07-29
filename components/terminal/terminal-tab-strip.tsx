"use client"

/**
 * Horizontal tab strip shared by the desktop dock and the mobile
 * full-screen terminal screen. Presentational — owns no state, no
 * spawn logic, no store reads. Both shells filter tabs to the active
 * project upstream and pass the array in.
 *
 * Right-edge controls (e.g. "+ New", close-panel button, connection
 * badge) are slotted via `trailing` so the strip doesn't need to know
 * about transport variants or shell affordances.
 */

import type { MouseEvent, ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"

import { TerminalTab } from "./terminal-tab"

export interface TerminalTabStripProps {
  tabs: TerminalSessionRow[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Right-click handler — wired to the context menu in Wave 3A. */
  onContextMenu?: (row: TerminalSessionRow, e: MouseEvent<HTMLElement>) => void
  /** Right-aligned controls (spawn, close-panel, connection badge…). */
  trailing?: ReactNode
  /** Optional className override for the outer strip container. */
  className?: string
  /** Optional `data-testid` override. Defaults to `"terminal-tab-strip"`. */
  testId?: string
}

export function TerminalTabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  trailing,
  className,
  testId = "terminal-tab-strip",
}: TerminalTabStripProps) {
  // Tabs fade+slide in on open and out on close instead of popping. The strip
  // is chrome-only (no xterm), so animating it never touches terminal layout.
  const { reduce, durationScale } = useFlowMotion()
  return (
    <div
      className={
        className ?? "flex items-center gap-1 overflow-x-auto border-b bg-muted/30 px-1.5 pt-1.5"
      }
      data-testid={testId}
    >
      <AnimatePresence initial={false}>
        {tabs.map((row) => (
          <motion.div
            key={row.id}
            className="shrink-0"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: reduce ? 0 : 0.16 * durationScale, ease: "easeOut" }}
          >
            <TerminalTab
              row={row}
              active={row.id === activeId}
              onSelect={onSelect}
              onClose={onClose}
              onContextMenu={onContextMenu ? (e) => onContextMenu(row, e) : undefined}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {trailing ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pb-1 pr-1">{trailing}</div>
      ) : null}
    </div>
  )
}

export default TerminalTabStrip
