"use client"

/**
 * One card in the device dashboard.
 *
 * The frame itself now lives in `components/surface/console-section.tsx`:
 * nothing about it was device-specific, and `/workspace` was building the same
 * card out of bare `<section>` elements. This file stays as the device-facing
 * name so the `device-section-*` anchors and test ids keep working, and so a
 * caller here cannot forget to pass `pane="device-pane"`.
 *
 * `wide` is the layout hint rather than a class, so a section declares "I hold
 * a matrix" and the grid decides what that means at the current pane width.
 * Callers passing `col-span-*` themselves is how a grid ends up with one card
 * that never lines up.
 */

import { ConsoleSection } from "@/components/surface/console-section"

export interface DeviceSectionProps {
  /** Anchor id, also the `data-testid` suffix. */
  id: string
  title: string
  icon?: React.ComponentProps<typeof ConsoleSection>["icon"]
  /** Right-aligned counter or status, kept to a few characters. */
  meta?: React.ReactNode
  /** One line under the title, for a section whose scope is not obvious. */
  description?: string
  /** Spans the full grid width, for matrices and lists, not fact pairs. */
  wide?: boolean
  children: React.ReactNode
  className?: string
}

export function DeviceSection(props: DeviceSectionProps) {
  return <ConsoleSection {...props} pane="device-pane" idPrefix="device-section" />
}
