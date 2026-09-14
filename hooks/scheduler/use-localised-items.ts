"use client"

/**
 * Resolve the i18n-keyed names some sources carry (ADR-0179).
 *
 * The backup schedule and the outbound queue have no user-given name, so
 * their sources used to bake English into `name`. They now also carry a
 * `nameKey`; this hook resolves it in the viewer's locale once, so every
 * pane, the attention block and the list order see the same string.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

export function localiseItem(
  item: UnifiedScheduledItem,
  t: (key: string, values?: Record<string, string | number>) => string
): UnifiedScheduledItem {
  if (!item.nameKey && !item.descriptionKey) return item
  return {
    ...item,
    name: item.nameKey ? t(item.nameKey, item.nameValues) : item.name,
    description: item.descriptionKey ? t(item.descriptionKey, item.nameValues) : item.description,
  }
}

export function useLocalisedItems(items: readonly UnifiedScheduledItem[]): UnifiedScheduledItem[] {
  const t = useTranslations("scheduler")
  return useMemo(() => items.map((item) => localiseItem(item, t)), [items, t])
}
