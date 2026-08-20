"use client"

import { useTranslations } from "next-intl"
import {
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ScrollTextIcon,
  ShareIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { mcpServerLogsHref } from "@/hooks/mcp/use-mcp-server-logs"
import type { McpServer } from "@cognia/agent-config-types"
import { summarizeServer } from "./mcp-server-utils"

/** How much of each row is drawn — persisted as the panel's view preference. */
export type McpRowDensity = "comfortable" | "compact"

export interface McpServerRowProps {
  server: McpServer
  /** This row is the one open in the detail pane. */
  active: boolean
  /** This row is in the batch-action selection. */
  selected: boolean
  favorite: boolean
  density: McpRowDensity
  /** Discovered tool count, or undefined when the server was never probed. */
  toolCount?: number
  /** How many of those tools the deny rules currently block. */
  deniedToolCount?: number
  onOpen: (id: string) => void
  onToggleSelect: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggle: (enabled: boolean) => void | Promise<void>
  onEdit: (id: string) => void
  onClone: (server: McpServer) => void
  onExport: (server: McpServer) => void
  onDelete: (server: McpServer) => void
}

const TRUST_DOT: Record<string, string> = {
  trusted: "bg-emerald-500",
  pending: "bg-amber-500",
  blocked: "bg-destructive",
  legacy: "bg-muted-foreground/40",
}

/**
 * One row in the master list. Deliberately thin: identity, state, the enable
 * switch, and a batch checkbox. Everything that needs room — tools, agent
 * projection, auth, logs — lives in the detail pane, so the rail stays
 * scannable at a hundred servers instead of growing a sixth icon button.
 */
export function McpServerRow({
  server,
  active,
  selected,
  favorite,
  density,
  toolCount,
  deniedToolCount = 0,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onToggle,
  onEdit,
  onClone,
  onExport,
  onDelete,
}: McpServerRowProps) {
  const tRow = useTranslations("mcp.row")
  const tCard = useTranslations("mcp.card")
  const trustState = server.trust?.state ?? "legacy"
  const label = server.displayName?.trim() || server.name

  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={() => onOpen(server.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen(server.id)
        }
      }}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 text-left transition-colors",
        density === "compact" ? "py-1" : "py-1.5",
        active ? "border-primary/40 bg-accent" : "hover:bg-accent/50",
        !server.enabled && "opacity-70"
      )}
      data-testid="mcp-server-row"
      data-active={active}
    >
      <span onClick={(event) => event.stopPropagation()} className="flex shrink-0 items-center">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(server.id)}
          aria-label={tCard("selectAria", { name: label })}
        />
      </span>

      <span
        className={cn("size-1.5 shrink-0 rounded-full", TRUST_DOT[trustState])}
        title={tCard(`trust.${trustState}`)}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium">{label}</span>
          <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
            {server.transport}
          </span>
          {favorite && (
            <StarIcon className="size-3 shrink-0 fill-current text-amber-500" aria-hidden />
          )}
        </div>
        {density === "comfortable" && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {summarizeServer(server) || "—"}
            </span>
            {toolCount !== undefined && (
              <span
                className={cn(
                  "shrink-0 text-[10px] tabular-nums",
                  deniedToolCount > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
                )}
              >
                {deniedToolCount > 0
                  ? tRow("toolsWithDenied", { total: toolCount, denied: deniedToolCount })
                  : tRow("toolsCount", { count: toolCount })}
              </span>
            )}
          </div>
        )}
      </div>

      <span
        onClick={(event) => event.stopPropagation()}
        className="flex shrink-0 items-center gap-0.5"
      >
        <Switch
          checked={server.enabled}
          onCheckedChange={(value) => void onToggle(value)}
          aria-label={
            server.enabled
              ? tRow("disableSwitch", { name: label })
              : tRow("enableSwitch", { name: label })
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 opacity-60 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label={tRow("moreActions", { name: label })}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={() => onToggleFavorite(server.id)}>
              <StarIcon className={cn("size-3.5", favorite && "fill-current text-amber-500")} />
              {favorite ? tCard("unfavorite", { name: label }) : tCard("favorite", { name: label })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(server.id)}>
              <PencilIcon className="size-3.5" />
              {tRow("edit", { name: label })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onClone(server)}>
              <CopyIcon className="size-3.5" />
              {tCard("clone", { name: label })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onExport(server)}>
              <ShareIcon className="size-3.5" />
              {tRow("export", { name: label })}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={mcpServerLogsHref(server.name)}>
                <ScrollTextIcon className="size-3.5" />
                {tRow("logs", { name: label })}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(server)}>
              <Trash2Icon className="size-3.5" />
              {tRow("delete", { name: label })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  )
}
