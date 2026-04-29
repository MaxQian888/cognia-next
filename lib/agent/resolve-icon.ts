/**
 * Shared dynamic Lucide icon resolver
 *
 * Centralizes the `import * as Icons` pattern to a single module,
 * so the full icon set is only bundled once instead of duplicated
 * across multiple components.
 */

import * as Icons from "lucide-react"
import type { LucideIcon } from "lucide-react"

/**
 * Full Lucide icon map for dynamic name-based lookups.
 * Import this instead of `import * as Icons from 'lucide-react'`
 * to centralize the namespace import in one module.
 */
export const LucideIcons = Icons as unknown as Record<string, LucideIcon>

export type { LucideIcon }
