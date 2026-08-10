"use client"

import { motion } from "motion/react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { STAGGER_CHILD, STAGGER_CONTAINER, MOBILE_SPRING } from "@/lib/ui/motion"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MEMORY_NAV_ITEMS, type MemoryPanelId } from "./nav-config"

export interface MemoryNavProps {
  activeId: MemoryPanelId
  onSelect: (id: MemoryPanelId) => void
  /** Unresolved conflicts, surfaced on the overview row so it is visible from any panel. */
  conflictCount?: number
  /** Renders a warning dot on the retrieval row when recall silently degraded. */
  retrievalDegraded?: boolean
  /**
   * Distinguishes the two mounts of this nav. The desktop rail is only
   * `display:none` below `md`, so while the mobile Sheet is open BOTH copies
   * are in the tree — and only one element may ever carry a given shared-layout
   * `layoutId`. Sharing one made Motion light the selection pill on a second,
   * unselected row.
   */
  idPrefix?: string
}

export function MemoryNav({
  activeId,
  onSelect,
  conflictCount = 0,
  retrievalDegraded = false,
  idPrefix = "memory",
}: MemoryNavProps) {
  const t = useTranslations("settings.memory.nav")
  const { reduce } = useFlowMotion()

  return (
    <motion.div
      role="list"
      aria-label={t("title")}
      className="min-h-0 flex-1 overflow-y-auto p-2"
      variants={reduce ? undefined : STAGGER_CONTAINER}
      initial={reduce ? undefined : "initial"}
      animate={reduce ? undefined : "animate"}
    >
      {MEMORY_NAV_ITEMS.map(({ id, icon: Icon }) => {
        const isActive = id === activeId
        const badge =
          id === "overview" && conflictCount > 0
            ? String(conflictCount)
            : id === "retrieval" && retrievalDegraded
              ? "!"
              : undefined

        return (
          <motion.div
            key={id}
            role="listitem"
            variants={reduce ? undefined : STAGGER_CHILD}
            className="relative"
          >
            {/* The selection pill is its own layer so it slides between rows via
                shared layout instead of every row cross-fading its background.
                Under `reduce` only one element may ever carry this layoutId, so
                the pill is dropped entirely and the row paints its own bg. */}
            {isActive && !reduce ? (
              <motion.div
                layoutId={`${idPrefix}-nav-pill`}
                transition={MOBILE_SPRING}
                className="absolute inset-0 rounded-md bg-accent"
                aria-hidden
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              aria-current={isActive ? "true" : undefined}
              data-testid={`${idPrefix}-nav-item-${id}`}
              data-active={isActive}
              onClick={() => onSelect(id)}
              className={cn(
                "relative h-auto w-full items-start justify-start gap-2.5 whitespace-normal rounded-md px-2.5 py-2 text-left font-normal",
                "transition-[transform,background-color] duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "hover:translate-x-0.5 hover:bg-accent/50",
                isActive && (reduce ? "bg-accent text-accent-foreground" : "text-accent-foreground")
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t(`items.${id}.label`)}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t(`items.${id}.description`)}
                </span>
              </span>
              {badge ? (
                <Badge
                  variant={id === "overview" ? "destructive" : "secondary"}
                  className="mt-0.5 shrink-0 px-1.5 text-[10px]"
                  data-testid={`${idPrefix}-nav-badge-${id}`}
                >
                  {badge}
                </Badge>
              ) : null}
            </Button>
          </motion.div>
        )
      })}
    </motion.div>
  )
}
