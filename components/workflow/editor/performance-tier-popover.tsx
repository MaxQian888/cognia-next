"use client"

/**
 * Performance-tier fields for the workflow editor canvas toolbar.
 *
 * Renders a title + four radio options (auto / high / balanced / reduced) and,
 * when the active choice is `auto`, a footer revealing the currently-resolved
 * tier so the user can see what the auto resolver chose.
 *
 * This is a dumb body component (render value + emit onChange); persistence is
 * driven through `useEffectivePerfTier` upstream. It is embedded inside the
 * canvas toolbar's "View" popover (see `canvas-toolbar.tsx`).
 */

import { useTranslations } from "next-intl"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type {
  PerformanceTier,
  ResolvedPerformanceTier,
} from "@/lib/workflow/editor/performance-tier"

const TIER_ORDER: readonly PerformanceTier[] = ["auto", "high", "balanced", "reduced"] as const

export interface PerformanceTierFieldsProps {
  value: PerformanceTier
  effective: ResolvedPerformanceTier
  onChange: (tier: PerformanceTier) => void
  className?: string
}

export function PerformanceTierFields({
  value,
  effective,
  onChange,
  className,
}: PerformanceTierFieldsProps) {
  const t = useTranslations("workflows.editor.performanceTier")

  return (
    <div className={cn("space-y-3", className)} data-testid="perf-tier-fields">
      <div>
        <div className="text-sm font-medium">{t("title")}</div>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as PerformanceTier)}
        aria-label={t("title")}
        className="gap-2"
      >
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="flex items-start gap-2">
            <RadioGroupItem value={tier} id={`perf-tier-${tier}`} className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <Label htmlFor={`perf-tier-${tier}`} className="text-sm leading-tight cursor-pointer">
                {t(tier)}
              </Label>
              <p className="text-xs text-muted-foreground leading-snug">{t(`${tier}Hint`)}</p>
            </div>
          </div>
        ))}
      </RadioGroup>
      {value === "auto" ? (
        <div
          className="rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
          data-testid="perf-tier-effective-footer"
        >
          {t("effectiveLabel", { tier: t(effective) })}
        </div>
      ) : null}
    </div>
  )
}
