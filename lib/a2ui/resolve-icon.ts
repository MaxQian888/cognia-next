/**
 * Icon resolution utility for A2UI components
 * Centralizes the pattern of resolving Lucide icon names to components
 */

import { icons, type LucideIcon } from "lucide-react"

import { toLucideIconName } from "@/lib/icons/lucide-icon-name"

/**
 * Resolve a Lucide icon name string to its component.
 * Returns null if the name is undefined or not found in the icon registry.
 *
 * Falls back to the kebab-case spelling the plugin contract used to publish, so
 * a plugin pinned to `"file-text"` still renders rather than silently showing
 * nothing. Exact matches are tried first — no already-valid name changes
 * meaning.
 */
export function resolveIcon(iconName?: string): LucideIcon | null {
  if (!iconName) return null
  const exact = icons[iconName as keyof typeof icons] as LucideIcon | undefined
  if (exact) return exact
  return (icons[toLucideIconName(iconName) as keyof typeof icons] as LucideIcon) ?? null
}
