"use client"

// Side-rail (xl+) / horizontal strip (below xl) listing the user's saved
// custom themes. Each item shows a 2×2 swatch built from the light and
// dark variants so two same-named themes can be told apart at a glance.
// Per-item DropdownMenu exposes Activate / Duplicate / Export / Delete —
// previously these only existed as inline buttons (Export) or required
// selecting the theme first (Activate / Delete). Pure presentation —
// callers own the mutations.

import { CheckIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { CustomTheme } from "@/types/plugin/plugin-extended"
import { cn } from "@/lib/utils"

export interface SavedThemesRailLabels {
  title: string
  empty: string
  startNew: string
  activate: string
  deactivate: string
  duplicate: string
  export: string
  delete: string
  more: string
  lightSwatchAria: string
  darkSwatchAria: string
  activeBadgeAria: string
}

export interface SavedThemesRailProps {
  themes: CustomTheme[]
  activeId: string | null
  /** Currently-edited theme; used to highlight the row being edited. */
  editingId: string | undefined
  labels: SavedThemesRailLabels
  onSelect: (theme: CustomTheme) => void
  onActivate: (id: string) => void
  onDeactivate: () => void
  onDuplicate: (theme: CustomTheme) => void
  onExport: (theme: CustomTheme) => void
  onDelete: (id: string) => void
  /** Triggered from the empty-state button. */
  onNew: () => void
  className?: string
}

interface VariantSwatch {
  bg: string
  primary: string
}

/** Read a usable colour for the variant, preferring the new dual-variant `tokens` shape. */
function readVariantSwatch(theme: CustomTheme, variant: "light" | "dark"): VariantSwatch {
  const tokens = theme.tokens?.[variant]
  if (tokens) {
    return { bg: tokens.background ?? "#888", primary: tokens.primary ?? "#888" }
  }
  // Legacy single-variant rows only have one side populated.
  const matchesLegacy =
    (variant === "dark" && theme.isDark === true) || (variant === "light" && theme.isDark === false)
  if (matchesLegacy && theme.colors) {
    return { bg: theme.colors.background ?? "#888", primary: theme.colors.primary ?? "#888" }
  }
  // Fallback: render a muted swatch so the slot doesn't collapse visually.
  return { bg: variant === "dark" ? "#0b1220" : "#fafafa", primary: "#888" }
}

interface ThemeItemProps {
  theme: CustomTheme
  active: boolean
  editing: boolean
  labels: SavedThemesRailLabels
  onSelect: () => void
  onActivate: () => void
  onDeactivate: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete: () => void
}

function ThemeItem({
  theme,
  active,
  editing,
  labels,
  onSelect,
  onActivate,
  onDeactivate,
  onDuplicate,
  onExport,
  onDelete,
}: ThemeItemProps) {
  const light = readVariantSwatch(theme, "light")
  const dark = readVariantSwatch(theme, "dark")
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md border bg-card/40 px-2 py-1.5 text-xs transition",
        editing ? "border-primary ring-1 ring-primary/30" : "border-border hover:bg-card/70",
        active && !editing && "bg-primary/10"
      )}
      data-testid={`saved-theme-${theme.id}`}
      data-active={active || undefined}
      data-editing={editing || undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        aria-pressed={editing}
      >
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-sm border border-border/60"
          data-testid={`saved-theme-${theme.id}-swatch`}
        >
          <span style={{ background: light.bg }} aria-label={labels.lightSwatchAria} />
          <span style={{ background: light.primary }} />
          <span style={{ background: dark.bg }} aria-label={labels.darkSwatchAria} />
          <span style={{ background: dark.primary }} />
        </span>
        <span className="truncate font-medium">{theme.name}</span>
        {active && (
          <CheckIcon
            className="size-3 shrink-0 text-primary"
            aria-label={labels.activeBadgeAria}
            data-testid={`saved-theme-${theme.id}-active`}
          />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 opacity-60 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={labels.more}
            data-testid={`saved-theme-${theme.id}-more`}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {active ? (
            <DropdownMenuItem
              onSelect={onDeactivate}
              data-testid={`saved-theme-${theme.id}-deactivate`}
            >
              {labels.deactivate}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={onActivate}
              data-testid={`saved-theme-${theme.id}-activate`}
            >
              {labels.activate}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={onDuplicate}
            data-testid={`saved-theme-${theme.id}-duplicate`}
          >
            {labels.duplicate}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport} data-testid={`saved-theme-${theme.id}-export`}>
            {labels.export}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onDelete}
            variant="destructive"
            data-testid={`saved-theme-${theme.id}-delete`}
          >
            {labels.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function SavedThemesRail({
  themes,
  activeId,
  editingId,
  labels,
  onSelect,
  onActivate,
  onDeactivate,
  onDuplicate,
  onExport,
  onDelete,
  onNew,
  className,
}: SavedThemesRailProps) {
  return (
    <aside
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border bg-muted/20 p-2",
        "xl:max-h-[60vh] xl:min-h-0",
        className
      )}
      data-testid="saved-themes-rail"
      aria-label={labels.title}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.title}
        </h4>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onNew}
          aria-label={labels.startNew}
          data-testid="saved-themes-rail-new"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      {themes.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-1 py-3">
          <p className="text-xs text-muted-foreground">{labels.empty}</p>
          <Button size="sm" variant="outline" onClick={onNew}>
            <PlusIcon className="mr-1 size-3" />
            {labels.startNew}
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            // Mobile / tablet: horizontal strip that wraps.
            "flex flex-wrap gap-2",
            // xl+: vertical scrolling list.
            "xl:flex-col xl:flex-nowrap xl:overflow-y-auto"
          )}
          data-testid="saved-themes-rail-list"
        >
          {themes.map((theme) => (
            <ThemeItem
              key={theme.id}
              theme={theme}
              active={theme.id === activeId}
              editing={theme.id === editingId}
              labels={labels}
              onSelect={() => onSelect(theme)}
              onActivate={() => onActivate(theme.id)}
              onDeactivate={onDeactivate}
              onDuplicate={() => onDuplicate(theme)}
              onExport={() => onExport(theme)}
              onDelete={() => onDelete(theme.id)}
            />
          ))}
        </div>
      )}
    </aside>
  )
}
