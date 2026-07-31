"use client"

import { HistoryIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Compact `host + path` label for a menu row; raw string when unparseable. */
function historyLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return url
  }
}

/** Recent-URL dropdown for the address bar. Clicking a row re-navigates there. */
export function BrowserHistoryMenu({
  recent,
  onNavigate,
  onClear,
  disabled,
}: {
  recent: string[]
  onNavigate: (url: string) => void
  onClear: () => void
  disabled?: boolean
}) {
  const t = useTranslations("browser.history")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip={t("label")} aria-label={t("label")} disabled={disabled}>
          <HistoryIcon />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        {recent.length === 0 ? (
          <DropdownMenuItem disabled>{t("empty")}</DropdownMenuItem>
        ) : (
          <>
            {recent.map((url) => (
              <DropdownMenuItem key={url} onClick={() => onNavigate(url)}>
                <span className="truncate font-mono text-xs">{historyLabel(url)}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClear}>{t("clear")}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
