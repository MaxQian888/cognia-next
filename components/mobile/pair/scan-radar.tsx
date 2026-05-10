"use client"

import { WifiIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface ScanRadarProps {
  active: boolean
  className?: string
}

/**
 * Decorative radar visualisation rendered above the discovered-server
 * list during a scan. Two concentric rings expand outward in a loop;
 * `html[data-reduce-motion="true"]` short-circuits the keyframe to a
 * static stroke (per app/globals.css).
 *
 * The component is purely presentational — it never renders text and
 * carries `aria-hidden`. Visible status text (e.g. "Scanning…") is
 * the caller's responsibility.
 */
export function ScanRadar({ active, className }: ScanRadarProps) {
  return (
    <div
      aria-hidden="true"
      data-state={active ? "active" : "idle"}
      data-testid="pair-scan-radar"
      className={cn(
        "relative mx-auto flex size-32 items-center justify-center sm:size-40",
        className
      )}
    >
      <span
        className={cn(
          "pair-radar-ring absolute inset-0 rounded-full border border-primary/40",
          active && "pair-radar-ring--active"
        )}
        data-ring="outer"
      />
      <span
        className={cn(
          "pair-radar-ring absolute inset-3 rounded-full border border-primary/60",
          active && "pair-radar-ring--active pair-radar-ring--inner"
        )}
        data-ring="inner"
      />
      <span
        className={cn(
          "relative inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary",
          active ? "shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_15%,transparent)]" : ""
        )}
      >
        <WifiIcon className="size-6" />
      </span>
    </div>
  )
}
