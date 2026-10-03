"use client"

import { useTranslations } from "next-intl"
import {
  EyeOffIcon,
  LayoutListIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Settings2Icon,
} from "lucide-react"

import { useSessionSummaryCardPrefs } from "@/components/shell/use-session-summary-card-prefs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import {
  SUMMARY_CARD_ROW_IDS,
  SUMMARY_CARD_ROW_VISIBILITIES,
  type SummaryCardRowVisibility,
} from "@/types/shell/session-summary-card"

export interface SessionSummaryCardMenuProps {
  sessionId: string
  mode: "float" | "popover"
  onManageSources: () => void
  /** Float mode: put the card away for this conversation. */
  onHide?: () => void
}

/**
 * The card's `⋯` menu: per-row visibility (always / when present / hidden),
 * a reset, and the ways out to the full Task overview and the capabilities
 * settings. Visibility is a preference, so it applies to every conversation.
 */
export function SessionSummaryCardMenu({
  sessionId,
  mode,
  onManageSources,
  onHide,
}: SessionSummaryCardMenuProps) {
  const t = useTranslations("contextWorkbench.summaryCard")
  const { rows, isDefault, setRow, reset } = useSessionSummaryCardPrefs()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={t("menu")}
        >
          <MoreHorizontalIcon className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("showOnCard")}
        </DropdownMenuLabel>
        {SUMMARY_CARD_ROW_IDS.map((id) => (
          <DropdownMenuSub key={id}>
            <DropdownMenuSubTrigger className="text-[13px]">
              <span className="flex-1">{t(`rows.${id}`)}</span>
              <span className="text-xs text-muted-foreground">{t(`visibility.${rows[id]}`)}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={rows[id]}
                onValueChange={(value) => void setRow(id, value as SummaryCardRowVisibility)}
              >
                {SUMMARY_CARD_ROW_VISIBILITIES.map((visibility) => (
                  <DropdownMenuRadioItem key={visibility} value={visibility}>
                    {t(`visibility.${visibility}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        <DropdownMenuItem disabled={isDefault} onSelect={() => void reset()}>
          <RotateCcwIcon className="size-4" aria-hidden />
          {t("resetRows")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => revealSessionPanel(sessionId, "metadata")}>
          <LayoutListIcon className="size-4" aria-hidden />
          {t("openOverview")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onManageSources}>
          <Settings2Icon className="size-4" aria-hidden />
          {t("addSource")}
        </DropdownMenuItem>
        {mode === "float" && onHide ? (
          <DropdownMenuItem onSelect={onHide}>
            <EyeOffIcon className="size-4" aria-hidden />
            {t("unpinCard")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
