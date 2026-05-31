"use client"

/**
 * Dropdown affordance attached to the right of the command-center pill —
 * VSCode's command-center caret. The pill itself still opens the command
 * palette on click; this caret reveals quick targets (palette, recent
 * sessions, go-to-view) without disturbing the render-stable pill leaf.
 *
 * Receives data + handlers as props (owned by `TitleBar`) so it carries no
 * store subscriptions of its own.
 */

import { ChevronDownIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { MenuActionId } from "@/lib/desktop/menu-actions"
import { cn } from "@/lib/utils"

// Disable the WebView2-expensive enter/exit keyframes. Do NOT add
// `will-change`/transform here: Radix renders the (fixed-positioned) submenu
// content as a DOM child of this menu, so a containing block on the parent
// would let its `overflow-hidden` clip the second-level submenu out of view.
const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm"

// Curated "Go to View" targets — a subset of the Go menu surfaced inline.
const GO_TARGETS: Array<{ id: MenuActionId; key: string }> = [
  { id: "go-inbox", key: "inbox" },
  { id: "go-workflows", key: "workflows" },
  { id: "go-agent-teams", key: "agentTeams" },
  { id: "go-scheduler", key: "scheduler" },
  { id: "go-discover", key: "discover" },
  { id: "go-plugins", key: "plugins" },
  { id: "go-settings", key: "settings" },
]

export interface RecentSessionEntry {
  id: string
  title: string
  characterId?: string
}

export function TitleBarCommandCenterMenu({
  recentSessions,
  onCommandPalette,
  onOpenRecentSession,
  onGo,
  className,
}: {
  recentSessions: RecentSessionEntry[]
  onCommandPalette: () => void
  onOpenRecentSession: (sessionId: string) => void
  onGo: (id: MenuActionId) => void
  className?: string
}) {
  const t = useTranslations("desktop.titleBar.commandCenter")
  const tMenu = useTranslations("desktop.menu")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid="title-bar-command-center-menu"
          aria-label={t("menuLabel")}
          title={t("menuLabel")}
          className={cn(
            "h-6 w-5 shrink-0 rounded-md rounded-l-none border border-l-0 border-border",
            "bg-background/60 text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
            "motion-safe:transition-transform motion-safe:active:scale-90",
            className
          )}
        >
          <ChevronDownIcon className="size-3" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className={cn("w-56", MENU_CONTENT_PERF)}>
        <DropdownMenuItem onSelect={onCommandPalette} data-testid="cc-command-palette">
          {tMenu("view.commandPalette")}
          <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftP")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t("recentSessions")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={MENU_CONTENT_PERF}>
            {recentSessions.length === 0 ? (
              <DropdownMenuItem disabled>{t("noRecent")}</DropdownMenuItem>
            ) : (
              recentSessions.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  data-testid={`cc-recent-${s.id}`}
                  onSelect={() => onOpenRecentSession(s.id)}
                >
                  {s.title || t("untitled")}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t("goToView")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={MENU_CONTENT_PERF}>
            {GO_TARGETS.map((g) => (
              <DropdownMenuItem
                key={g.id}
                data-testid={`cc-go-${g.id}`}
                onSelect={() => onGo(g.id)}
              >
                {tMenu(`go.${g.key}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
