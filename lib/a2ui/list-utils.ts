/**
 * A2UI List Utilities
 * Helper functions for list item rendering
 */

/**
 * Get a unique key for a list item
 */
export function getItemKey(item: unknown, index: number): string | number {
  if (typeof item === "object" && item !== null && "id" in item) {
    return (item as { id: string | number }).id
  }
  return index
}

/**
 * Extract display text from a list item
 */
export function getItemDisplayText(item: unknown): string {
  if (typeof item === "string") return item
  if (typeof item === "number" || typeof item === "boolean") return String(item)
  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>
    return String(obj.label || obj.text || obj.name || obj.title || JSON.stringify(item))
  }
  return String(item)
}
