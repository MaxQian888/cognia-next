/**
 * Icon resolution utility for A2UI components
 * Centralizes the pattern of resolving Lucide icon names to components
 */

import type { LucideIcon } from "lucide-react"

import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"

/**
 * Resolve a Lucide icon name string to its component.
 * Returns null if the name is undefined or not found in the icon registry.
 *
 * Accepts every spelling the manifest validator accepts — a lucide export name
 * (where lucide's own renames survive as aliases) and the kebab-case spelling
 * the plugin contract used to publish — so a plugin pinned to `"file-text"` or
 * `"history"` still renders rather than silently showing nothing. See
 * [`resolveLucideIcon`] for the order; exact matches win.
 */
export function resolveIcon(iconName?: string): LucideIcon | null {
  return resolveLucideIcon(iconName)
}
