"use client"

/**
 * Left rail for the desktop discover page — an Accordion of super-groups,
 * each holding the implemented categories from the registry. Categories
 * that haven't shipped yet (Phase 3/5 ids) are simply absent from
 * `DISCOVER_CATEGORIES` until their data source + card land.
 */

import { useTranslations } from "next-intl"
import {
  CompassIcon,
  FileEditIcon,
  InboxIcon,
  PlugIcon,
  PuzzleIcon,
  ScanTextIcon,
  SparklesIcon,
  UsersIcon,
  UsersRoundIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import {
  DISCOVER_GROUPS,
  getCategoriesByGroup,
  type DiscoverCategory,
  type DiscoverCategoryId,
  type DiscoverGroup,
} from "@/lib/discover/categories"
import { cn } from "@/lib/utils"

/**
 * Resolve a category's `iconName` (a string in the data registry — keeps
 * the registry React-free) to the matching lucide-react component.
 * Falls back to a generic compass icon for ids that haven't grown a
 * dedicated icon yet.
 */
const ICON_BY_NAME: Record<string, React.ComponentType<{ className?: string }>> = {
  Users: UsersIcon,
  UsersRound: UsersRoundIcon,
  Sparkles: SparklesIcon,
  Puzzle: PuzzleIcon,
  FileEdit: FileEditIcon,
  Wrench: WrenchIcon,
  Plug: PlugIcon,
  ScanText: ScanTextIcon,
  Workflow: WorkflowIcon,
  Inbox: InboxIcon,
}

function iconFor(iconName: string): React.ComponentType<{ className?: string }> {
  return ICON_BY_NAME[iconName] ?? CompassIcon
}

export interface DiscoverCategorySidebarProps {
  activeCategory: DiscoverCategoryId
  onSelect: (id: DiscoverCategoryId) => void
  className?: string
}

export function DiscoverCategorySidebar({
  activeCategory,
  onSelect,
  className,
}: DiscoverCategorySidebarProps) {
  const t = useTranslations("discover")

  // Only render groups that have at least one implemented category. Empty
  // groups (e.g. "templates" until Phase 3) would otherwise render an
  // empty Accordion entry, which looks broken.
  const populatedGroups: { group: DiscoverGroup; categories: DiscoverCategory[] }[] =
    DISCOVER_GROUPS.map((group) => ({ group, categories: getCategoriesByGroup(group) })).filter(
      ({ categories }) => categories.length > 0
    )

  return (
    <nav
      aria-label={t("groups.aria")}
      className={cn("flex h-full flex-col overflow-y-auto py-2", className)}
      data-testid="discover-category-sidebar"
    >
      <Accordion
        type="multiple"
        defaultValue={populatedGroups.map(({ group }) => group)}
        className="px-2"
      >
        {populatedGroups.map(({ group, categories }) => (
          <AccordionItem key={group} value={group} className="border-none">
            <AccordionTrigger
              className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              data-testid={`discover-group-${group}`}
            >
              {t(`groups.${group}`)}
            </AccordionTrigger>
            <AccordionContent className="pb-1 pt-0">
              <ul className="flex flex-col gap-0.5">
                {categories.map((cat) => {
                  const Icon = iconFor(cat.iconName)
                  const active = cat.id === activeCategory
                  return (
                    <li key={cat.id}>
                      <Button
                        type="button"
                        variant={active ? "secondary" : "ghost"}
                        size="sm"
                        onClick={() => onSelect(cat.id)}
                        className={cn(
                          "w-full justify-start gap-2 px-2 font-normal",
                          active && "font-medium"
                        )}
                        aria-current={active ? "page" : undefined}
                        data-testid={`discover-category-${cat.id}`}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{t(`categories.${cat.id}`)}</span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </nav>
  )
}
