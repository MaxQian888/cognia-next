/**
 * Icon resolution utility for A2UI components
 * Centralizes the pattern of resolving Lucide icon names to components
 */

import { icons, type LucideIcon } from "lucide-react"

/**
 * Resolve a Lucide icon name string to its component.
 * Returns null if the name is undefined or not found in the icon registry.
 */
export function resolveIcon(iconName?: string): LucideIcon | null {
  if (!iconName) return null
  return (icons[iconName as keyof typeof icons] as LucideIcon) ?? null
}
