"use client"

/**
 * Which engine a dock page tab is on, and the switch between them
 * (ADR-0214, D8): Cognia's local Chromium, or the lightweight preview on the
 * system webview — which keeps element pick, annotations, Browser Adjust and
 * the inspection rail. Shown in the address bar only where both are available.
 */

import { FeatherIcon, GlobeIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface BrowserEngineChipProps {
  engine: "local-chromium" | "embedded"
  onSwitch: (to: "local-chromium" | "embedded") => void
}

export function BrowserEngineChip({ engine, onSwitch }: BrowserEngineChipProps) {
  const t = useTranslations("browserLocal.pane.engineChip")
  const chromium = engine === "local-chromium"
  const Icon = chromium ? GlobeIcon : FeatherIcon
  const action = chromium ? t("toLightweight") : t("toChromium")
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
          aria-label={action}
          data-testid="browser-engine-chip"
          data-engine={engine}
          onClick={() => onSwitch(chromium ? "embedded" : "local-chromium")}
        >
          <Icon className="size-3.5" />
          {chromium ? t("chromium") : t("lightweight")}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{action}</TooltipContent>
    </Tooltip>
  )
}
