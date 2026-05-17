"use client"

/**
 * Toolbar-mounted control for the workflow editor's performance tier.
 *
 * Trigger: small gauge icon button. Click opens a popover with four radio
 * options (auto / high / balanced / reduced). When the active choice is
 * `auto`, a footer reveals the currently-resolved tier so the user can see
 * what the auto resolver chose.
 *
 * Persistence is driven through `useEffectivePerfTier` upstream — this
 * component is dumb: render value + emit onChange.
 */

import { Gauge } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type {
  PerformanceTier,
  ResolvedPerformanceTier,
} from "@/lib/workflow/editor/performance-tier"

const TIER_ORDER: readonly PerformanceTier[] = ["auto", "high", "balanced", "reduced"] as const

export interface PerformanceTierPopoverProps {
  value: PerformanceTier
  effective: ResolvedPerformanceTier
  onChange: (tier: PerformanceTier) => void
  /** Optional className applied to the trigger button (toolbar spacing). */
  className?: string
}

export function PerformanceTierPopover({
  value,
  effective,
  onChange,
  className,
}: PerformanceTierPopoverProps) {
  const t = useTranslations("workflows.editor.performanceTier")

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-8", className)}
              aria-label={t("title")}
              data-testid="perf-tier-trigger"
            >
              <Gauge className="size-4" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("title")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 space-y-3">
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
                <Label
                  htmlFor={`perf-tier-${tier}`}
                  className="text-sm leading-tight cursor-pointer"
                >
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
      </PopoverContent>
    </Popover>
  )
}
