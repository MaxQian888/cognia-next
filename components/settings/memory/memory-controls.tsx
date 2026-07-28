"use client"

/**
 * Local control primitives for the memory pane.
 *
 * `SettingsToggle` from `../common/settings-section` is close, but its `Label`
 * is not `htmlFor`-linked, so the Switch has no accessible name — and the pane
 * needs the gate-driven fade below, which that component cannot express. Both
 * live here rather than being pushed into the shared component, which many
 * other sections render.
 */

import type { ReactNode } from "react"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export interface MemoryToggleRowProps {
  id: string
  label: string
  description: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

export function MemoryToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: MemoryToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <div className="text-[11px] leading-relaxed text-muted-foreground">{description}</div>
      </div>
      <Switch
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="mt-0.5 shrink-0"
      />
    </div>
  )
}

export interface GatedGroupProps {
  /** When true the group is inert: faded, non-interactive, hidden from AT. */
  gated: boolean
  /** Why it is inert — rendered above the group so the fade is never unexplained. */
  reason?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Fades a group of controls when an upstream switch turns them off. The
 * animation is the point: a whole column of controls snapping to grey reads as
 * a glitch, whereas a 280ms dim reads as a consequence of the switch that was
 * just flipped.
 *
 * `inert` (not just `opacity`) so faded controls cannot be tabbed into or
 * clicked — a dimmed-but-live control is worse than no animation at all.
 */
export function GatedGroup({ gated, reason, children, className }: GatedGroupProps) {
  const { reduce, speed } = useFlowMotion()

  return (
    <div className={className}>
      {gated && reason ? (
        <p
          className="mb-1 text-[11px] font-medium text-amber-600 dark:text-amber-500"
          data-testid="memory-gate-reason"
        >
          {reason}
        </p>
      ) : null}
      <motion.div
        // `inert` is a real attribute in React 19; it removes the subtree from
        // tab order and pointer events without touching each control.
        inert={gated}
        data-gated={gated ? "true" : undefined}
        animate={reduce ? undefined : { opacity: gated ? 0.5 : 1 }}
        initial={false}
        transition={
          reduce ? undefined : { duration: MOBILE_DURATION.normal * speed, ease: MOBILE_EASE }
        }
        className={cn(reduce && gated && "opacity-50")}
      >
        {children}
      </motion.div>
    </div>
  )
}
