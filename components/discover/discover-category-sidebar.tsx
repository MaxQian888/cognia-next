"use client"

/**
 * Left rail for the desktop discover page — an Accordion of super-groups, each
 * holding the visible categories from the user's layout (`useDiscoverLayout`).
 * Hidden categories are dropped; pinned categories sort before overflow within
 * their group. A pinned "Favorites" pseudo-category sits above the accordion,
 * and a "Customize" button opens the category customizer dialog.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CompassIcon, Settings2Icon, SparklesIcon, StarIcon } from "lucide-react"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DiscoverCustomizer } from "@/components/discover/discover-customizer"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import {
  DISCOVER_GROUPS,
  FAVORITES_CATEGORY,
  FORYOU_CATEGORY,
  type DiscoverCategory,
  type DiscoverGroup,
  type DiscoverView,
} from "@/lib/discover/categories"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { cn } from "@/lib/utils"

export interface DiscoverCategorySidebarProps {
  activeCategory: DiscoverView
  onSelect: (id: DiscoverView) => void
  className?: string
}

export function DiscoverCategorySidebar({
  activeCategory,
  onSelect,
  className,
}: DiscoverCategorySidebarProps) {
  const t = useTranslations("discover")
  const { resolved } = useDiscoverLayout()
  const [customizeOpen, setCustomizeOpen] = useState(false)

  // Visible categories = pinned (user order) then overflow (registry order),
  // hidden dropped. Group rendering preserves that combined order via filter.
  const visible = [...resolved.pinned, ...resolved.overflow]
  const populatedGroups: { group: DiscoverGroup; categories: DiscoverCategory[] }[] =
    DISCOVER_GROUPS.map((group) => ({
      group,
      categories: visible.filter((c) => c.group === group),
    })).filter(({ categories }) => categories.length > 0)

  return (
    <nav
      aria-label={t("groups.aria")}
      className={cn("flex h-full flex-col overflow-y-auto py-2", className)}
      data-testid="discover-category-sidebar"
    >
      <div className="px-3 pb-1">
        <Button
          type="button"
          variant={activeCategory === FORYOU_CATEGORY ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onSelect(FORYOU_CATEGORY)}
          className={cn(
            "w-full justify-start gap-2 px-2 font-normal",
            activeCategory === FORYOU_CATEGORY && "font-medium"
          )}
          aria-current={activeCategory === FORYOU_CATEGORY ? "page" : undefined}
          data-testid="discover-category-foryou"
        >
          <SparklesIcon className="size-4 shrink-0" />
          <span className="truncate">{t("categories.foryou")}</span>
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 pb-1">
        <Button
          type="button"
          variant={activeCategory === FAVORITES_CATEGORY ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onSelect(FAVORITES_CATEGORY)}
          className={cn(
            "flex-1 justify-start gap-2 px-2 font-normal",
            activeCategory === FAVORITES_CATEGORY && "font-medium"
          )}
          aria-current={activeCategory === FAVORITES_CATEGORY ? "page" : undefined}
          data-testid="discover-category-favorites"
        >
          <StarIcon className="size-4 shrink-0" />
          <span className="truncate">{t("categories.favorites")}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => setCustomizeOpen(true)}
          aria-label={t("customize.trigger")}
          data-testid="discover-customize-trigger"
        >
          <Settings2Icon className="size-4" />
        </Button>
      </div>

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
                  const Icon = resolveIcon(cat.iconName) ?? CompassIcon
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

      <Dialog open={customizeOpen} onOpenChange={setCustomizeOpen}>
        <DialogContent className="max-w-md" data-testid="discover-customize-dialog">
          <DialogHeader>
            <DialogTitle>{t("customize.title")}</DialogTitle>
            <DialogDescription>{t("customize.description")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-3">
            <DiscoverCustomizer />
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </nav>
  )
}
