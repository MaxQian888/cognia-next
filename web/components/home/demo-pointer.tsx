"use client"

import { useReducedMotion } from "motion/react"

import { Pointer } from "@web/components/ui/pointer"
import { useFinePointer } from "@web/hooks/use-fine-pointer"

interface DemoPointerProps {
  /** Label shown alongside the pointer (e.g., "Agent"). */
  label: string
}

/**
 * A scoped pointer showing the agent's virtual cursor interaction on demo surfaces.
 *
 * This is the page's only pointer enhancement and is intentionally scoped to
 * a product demonstration rather than mounted across the website shell.
 *
 * Gates:
 * - Fine pointer only (no touch/coarse)
 * - Hover-capable only
 * - Reduced motion: hidden entirely
 * - Never hides native cursor (enforced by the adapted Pointer component)
 */
export function DemoPointer({ label }: DemoPointerProps) {
  const reduced = useReducedMotion()
  const canShow = useFinePointer()

  if (reduced || !canShow) return null

  return (
    <Pointer>
      <div className="flex items-center gap-1.5">
        <span className="size-3 rounded-full border border-on-stage bg-action" />
        <span className="rounded-control bg-graphite px-2 py-0.5 text-[10px] font-medium text-on-stage">
          {label}
        </span>
      </div>
    </Pointer>
  )
}
