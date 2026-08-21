"use client"

/**
 * The Squads rail: a static Templates entry, then every Squad.
 *
 * Presentational — the section owns selection, the URL, and the store. Search
 * filters only the Squad list; Templates is how you get your first one, so
 * hiding it behind a query that matches nothing would strand a new user.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  SQUAD_ENTITY_ICON,
  SQUAD_STATIC_PANELS,
  squadPanelId,
  type SquadPanelId,
} from "./nav-config"

export interface SquadsNavItem {
  id: string
  name: string
  memberCount: number
}

export interface SquadsNavProps {
  squads: readonly SquadsNavItem[]
  activePanel: SquadPanelId
  onSelect: (panel: SquadPanelId) => void
  onCreate: () => void
}

export function SquadsNav({ squads, activePanel, onSelect, onCreate }: SquadsNavProps) {
  const t = useTranslations("settings.squads.nav")
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return squads
    return squads.filter((squad) => squad.name.toLowerCase().includes(q))
  }, [squads, query])

  const EntityIcon = SQUAD_ENTITY_ICON

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="squads-nav">
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 pl-7 text-xs"
            data-testid="squads-nav-search"
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="w-full text-xs"
          onClick={onCreate}
          data-testid="squads-nav-create"
        >
          <PlusIcon className="mr-1.5 size-3.5" />
          {t("create")}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5" role="list">
          {SQUAD_STATIC_PANELS.map(({ id, icon: Icon }) => (
            <NavRow
              key={id}
              active={activePanel === id}
              onSelect={() => onSelect(id)}
              testId="squads-nav-static"
            >
              <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" />
              <span className="truncate">{t(`static.${id}`)}</span>
            </NavRow>
          ))}

          <p className="px-2 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
            {t("squadsLabel")}
          </p>

          {filtered.length === 0 ? (
            <p
              className="px-2 py-2 text-[11px] text-muted-foreground"
              data-testid="squads-nav-empty"
            >
              {/* Two different situations, two different sentences: nothing
                  created yet, versus nothing matching what you typed. */}
              {squads.length === 0 ? t("noSquads") : t("noMatches")}
            </p>
          ) : (
            filtered.map((squad) => (
              <NavRow
                key={squad.id}
                active={activePanel === squadPanelId(squad.id)}
                onSelect={() => onSelect(squadPanelId(squad.id))}
                testId="squads-nav-squad"
              >
                <EntityIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{squad.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {squad.memberCount}
                </span>
              </NavRow>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function NavRow({
  active,
  onSelect,
  testId,
  children,
}: {
  active: boolean
  onSelect: () => void
  testId: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="listitem"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
        active && "bg-accent font-medium"
      )}
    >
      {children}
    </button>
  )
}

export default SquadsNav
