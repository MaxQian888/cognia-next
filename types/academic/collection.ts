/**
 * Academic Collection Type Definitions
 * Paper collections and smart collections
 */

import type { PaperSearchFilter } from "./search"

// ============================================================================
// Collection Types
// ============================================================================

export interface PaperCollection {
  id: string
  name: string
  description?: string
  color?: string
  icon?: string
  parentId?: string // For nested collections
  paperIds: string[]
  isSmartCollection?: boolean
  smartFilter?: PaperSearchFilter
  createdAt: Date
  updatedAt: Date
}

export interface CreateCollectionOptions {
  icon?: string
  parentId?: string
  isSmartCollection?: boolean
  smartFilter?: PaperSearchFilter
}
