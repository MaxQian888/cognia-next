"use client"

/**
 * Shared cell for the OCR capability matrix.
 *
 * Mirrors the `CapabilityCell` pattern from
 * `components/settings/provider/provider-comparison-view.tsx` (yes/no Check/X)
 * with an extra `partial` value (CircleDot) and a numeric variant for
 * `multilang` / `maxPagesPerCall` / `costTier`. Used by both the per-provider
 * Capabilities tab and the multi-provider Compare view.
 */

import * as React from "react"
import { Check, CircleDot, Infinity as InfinityIcon, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { OcrCapabilityValue, OcrCostTier } from "@/lib/ocr/capabilities"

interface BaseProps {
  className?: string
}

export function OcrCapabilityValueCell({
  value,
  className,
}: BaseProps & { value: OcrCapabilityValue }): React.ReactElement {
  const t = useTranslations()
  if (value === "yes") {
    return (
      <Check
        className={cn("mx-auto h-4 w-4 text-emerald-500", className)}
        aria-label={t("ocr.capabilities.values.yes")}
        data-testid="ocr-cap-yes"
      />
    )
  }
  if (value === "partial") {
    return (
      <CircleDot
        className={cn("mx-auto h-4 w-4 text-amber-500", className)}
        aria-label={t("ocr.capabilities.values.partial")}
        data-testid="ocr-cap-partial"
      />
    )
  }
  return (
    <X
      className={cn("mx-auto h-4 w-4 text-rose-400", className)}
      aria-label={t("ocr.capabilities.values.no")}
      data-testid="ocr-cap-no"
    />
  )
}

export function OcrCapabilityCostCell({
  tier,
  className,
}: BaseProps & { tier: OcrCostTier }): React.ReactElement {
  const t = useTranslations()
  const label =
    tier === "free"
      ? t("ocr.capabilities.values.free")
      : tier === "$"
        ? "$"
        : tier === "$$"
          ? "$$"
          : "$$$"
  const tone =
    tier === "free"
      ? "text-emerald-500"
      : tier === "$"
        ? "text-emerald-500"
        : tier === "$$"
          ? "text-amber-500"
          : "text-rose-400"
  return (
    <span
      className={cn("inline-flex font-mono text-xs font-semibold", tone, className)}
      data-testid="ocr-cap-cost"
    >
      {label}
    </span>
  )
}

export function OcrCapabilityCountCell({
  value,
  className,
}: BaseProps & { value: number | null }): React.ReactElement {
  if (value === null) {
    return (
      <InfinityIcon
        className={cn("mx-auto h-4 w-4 text-muted-foreground", className)}
        aria-label="unlimited"
        data-testid="ocr-cap-unlimited"
      />
    )
  }
  return (
    <span className={cn("inline-flex font-mono text-xs", className)} data-testid="ocr-cap-count">
      {value}
    </span>
  )
}
