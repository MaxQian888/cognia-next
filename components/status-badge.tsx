"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>

export interface StatusBadgeProps extends Omit<React.ComponentProps<typeof Badge>, "variant"> {
  value: string
  labelNamespace: string
  variantMap?: Record<string, BadgeVariant>
  fallbackVariant?: BadgeVariant
  pulse?: boolean
  pulseClassName?: string
}

const DEFAULT_VARIANT_MAP: Record<string, BadgeVariant> = {
  // shared positive states
  completed: "default",
  accepted: "default",
  succeeded: "default",
  parsed: "default",
  ok: "default",
  // active / in-progress
  running: "default",
  executing: "default",
  planning: "default",
  parsing: "default",
  inProgress: "default",
  in_progress: "default",
  claimed: "default",
  // neutral
  idle: "outline",
  pending: "outline",
  queued: "outline",
  paused: "outline",
  edited: "outline",
  review: "outline",
  blocked: "outline",
  // negative
  failed: "destructive",
  cancelled: "destructive",
  rejected: "destructive",
  error: "destructive",
  deleted: "destructive",
  disconnected: "destructive",
  shutdown: "destructive",
}

/**
 * StatusBadge — generic translated status pill.
 *
 * Looks up `t(value)` under `labelNamespace`; if the key is missing, falls back to the raw value.
 * Variant resolves via `variantMap` then falls back to {@link DEFAULT_VARIANT_MAP}, then `fallbackVariant`.
 * When `pulse` is on, prepends a small pulsing dot (uses current text color so it follows the variant).
 *
 * Honors `prefers-reduced-motion` by suppressing the fade-on-change animation.
 */
export function StatusBadge({
  value,
  labelNamespace,
  variantMap,
  fallbackVariant = "outline",
  pulse = false,
  pulseClassName,
  className,
  ...badgeProps
}: StatusBadgeProps) {
  const t = useTranslations(labelNamespace)
  const prefersReducedMotion = useReducedMotion()

  const label = React.useMemo(() => {
    try {
      // next-intl throws when a key is missing; treat that as "fall back to raw value".
      const translated = t(value)
      return translated && translated !== `${labelNamespace}.${value}` ? translated : value
    } catch {
      return value
    }
  }, [t, value, labelNamespace])

  const variant = variantMap?.[value] ?? DEFAULT_VARIANT_MAP[value] ?? fallbackVariant

  const inner = (
    <Badge
      {...badgeProps}
      variant={variant}
      className={cn("inline-flex items-center gap-1.5 transition-colors duration-150", className)}
    >
      {pulse && (
        <span
          aria-hidden
          className={cn(
            "inline-block size-1.5 shrink-0 rounded-full bg-current animate-pulse",
            pulseClassName
          )}
        />
      )}
      {label}
    </Badge>
  )

  if (prefersReducedMotion) {
    return inner
  }

  return (
    <motion.span
      key={`${value}-${variant}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="inline-flex"
    >
      {inner}
    </motion.span>
  )
}
