"use client"

/**
 * Dropdown affordance attached to the right of the command-center pill —
 * VSCode's command-center caret. The pill itself still opens the command
 * palette on click; this caret reveals quick targets (palette, recent
 * sessions, go-to-view) without disturbing the render-stable pill leaf.
 *
 * Everything lives in ONE flat menu — no second-level submenus. Radix renders
 * a `DropdownMenuSubContent` as a NON-portaled `position: fixed` descendant of
 * the scrollable `DropdownMenuContent` (`overflow-y-auto`); on the Tauri
 * WebView that submenu was getting clipped / left unclickable, so the "Recent
 * Sessions" and "Go to View" fly-outs were effectively unusable. Inlining the
 * two groups keeps every target one hover away and reliably clickable, and the
 * per-item icons make the surface easier to scan.
 *
 * Receives data + handlers as props (owned by `TitleBar`) so it carries no
 * store subscriptions of its own.
 */

import {
  CalendarClockIcon,
  ChevronDownIcon,
  CompassIcon,
  Globe2Icon,
  InboxIcon,
  MessageSquareIcon,
  PuzzleIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { MenuActionId } from "@/lib/desktop/menu-actions"
import { cn } from "@/lib/utils"

// Kill the WebView2-expensive enter/exit keyframes and soften the shadow.
const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm"

// Curated "Go to View" targets — a subset of the Go menu surfaced inline, each
// paired with the icon used for that destination elsewhere in the shell.
const GO_TARGETS: Array<{ id: MenuActionId; key: string; icon: LucideIcon }> = [
  { id: "go-inbox", key: "inbox", icon: InboxIcon },
  { id: "go-workflows", key: "workflows", icon: WorkflowIcon },
  { id: "go-sites", key: "sites", icon: Globe2Icon },
  { id: "go-squads", key: "squads", icon: UsersIcon },
  { id: "go-scheduler", key: "scheduler", icon: CalendarClockIcon },
  { id: "go-discover", key: "discover", icon: CompassIcon },
  { id: "go-plugins", key: "plugins", icon: PuzzleIcon },
  { id: "go-settings", key: "settings", icon: SettingsIcon },
]

// Cap the inline recent list so the flat menu stays a sane height.
const MAX_RECENT = 6

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
  const recent = recentSessions.slice(0, MAX_RECENT)

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
      <DropdownMenuContent align="center" className={cn("w-64", MENU_CONTENT_PERF)}>
        <DropdownMenuItem onSelect={onCommandPalette} data-testid="cc-command-palette">
          <SearchIcon aria-hidden />
          <span className="min-w-0 flex-1 truncate">{tMenu("view.commandPalette")}</span>
          <DropdownMenuShortcut>{tMenu("shortcut.cmdOrCtrlShiftP")}</DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("recentSessions")}
        </DropdownMenuLabel>
        {recent.length === 0 ? (
          <DropdownMenuItem disabled data-testid="cc-recent-empty">
            {t("noRecent")}
          </DropdownMenuItem>
        ) : (
          recent.map((s) => (
            <DropdownMenuItem
              key={s.id}
              data-testid={`cc-recent-${s.id}`}
              onSelect={() => onOpenRecentSession(s.id)}
            >
              <MessageSquareIcon aria-hidden />
              <span className="min-w-0 flex-1 truncate">{s.title || t("untitled")}</span>
            </DropdownMenuItem>
          ))
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("goToView")}
        </DropdownMenuLabel>
        {GO_TARGETS.map((g) => {
          const Icon = g.icon
          return (
            <DropdownMenuItem key={g.id} data-testid={`cc-go-${g.id}`} onSelect={() => onGo(g.id)}>
              <Icon aria-hidden />
              <span className="min-w-0 flex-1 truncate">{tMenu(`go.${g.key}`)}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
