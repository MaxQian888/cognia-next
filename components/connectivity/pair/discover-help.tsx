"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  BookOpenIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  HelpCircleIcon,
  SettingsIcon,
  WifiIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { open as openBrowser } from "@/lib/capacitor/browser"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { DOCS_COMPANION_SETUP_URL } from "@/lib/constants/external-urls"
import { cn } from "@/lib/utils"

export interface DiscoverHelpProps {
  /** Open by default + slightly heavier framing when the scan found nothing. */
  emphasised?: boolean
  /**
   * Render as a bare row — no frame, no side padding — for a parent that draws
   * its own hairline list (the Paired step).
   */
  flush?: boolean
  className?: string
}

/**
 * "Can't find your desktop?" troubleshooting helper for the pair flow.
 *
 * A collapsible that lists the three most common reasons a desktop fails to
 * surface (different network, firewall, companion server off) plus two
 * escape hatches: the docs site (opened in the in-app browser) and the iOS
 * Local Network settings deep link. Reused on the Discover, Pair, and
 * Paired steps so help is one tap away throughout onboarding.
 */
export function DiscoverHelp({ emphasised = false, flush = false, className }: DiscoverHelpProps) {
  const t = useTranslations("mobile.pair.discover")
  const [open, setOpen] = useState(emphasised)

  // Auto-expand when the caller turns on emphasis (e.g. the scan settled with
  // no servers). The user can still collapse it afterwards. Uses React's
  // "adjust state during render on prop change" pattern rather than an effect.
  const [prevEmphasised, setPrevEmphasised] = useState(emphasised)
  if (emphasised !== prevEmphasised) {
    setPrevEmphasised(emphasised)
    if (emphasised) setOpen(true)
  }

  const tips: Array<{ key: string; label: string }> = [
    { key: "same", label: t("help.tipSameNetwork") },
    { key: "firewall", label: t("help.tipFirewall") },
    { key: "server", label: t("help.tipEnableServer") },
  ]

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        !flush && "rounded-lg border bg-card/40",
        !flush && (emphasised ? "border-border" : "border-dashed"),
        className
      )}
      data-testid="pair-discover-help"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "touch-target h-auto w-full items-center justify-between gap-2 py-3 font-normal hover:bg-transparent",
            flush ? "px-0" : "px-4"
          )}
          data-testid="pair-discover-help-trigger"
        >
          <span className={cn("flex items-center text-sm font-medium", flush ? "gap-3" : "gap-2")}>
            <HelpCircleIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("help.trigger")}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("flex flex-col gap-3 pb-4", !flush && "px-4")}>
          <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            {tips.map((tip) => (
              <li key={tip.key} className="flex items-start gap-2">
                <WifiIcon
                  className="mt-0.5 size-3 shrink-0 text-muted-foreground/70"
                  aria-hidden="true"
                />
                <span>{tip.label}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="touch-target w-full sm:flex-1"
              onClick={() => void openBrowser({ url: DOCS_COMPANION_SETUP_URL })}
              data-testid="pair-discover-help-docs"
            >
              <BookOpenIcon className="size-4" aria-hidden="true" />
              {t("help.docsCta")}
              <ExternalLinkIcon className="size-3.5 opacity-70" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="touch-target w-full sm:flex-1"
              onClick={() => void openAppSettings()}
              data-testid="pair-discover-help-settings"
            >
              <SettingsIcon className="size-4" aria-hidden="true" />
              {t("help.openSettings")}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
