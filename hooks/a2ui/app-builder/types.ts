/**
 * A2UI App Builder - Shared Types
 */

import type { Locale } from "@/i18n/config"

/**
 * App author information
 */
export interface A2UIAppAuthor {
  name?: string
  email?: string
  url?: string
}

/**
 * App statistics for app store
 */
export interface A2UIAppStats {
  views?: number
  uses?: number
  rating?: number
  ratingCount?: number
}

/**
 * App instance metadata - Extended for app store support
 */
export interface A2UIAppInstance {
  // Core fields
  id: string
  templateId: string
  name: string
  createdAt: number
  lastModified: number
  /** Locale used for template payloads and action-generated copy. */
  locale?: Locale

  // Extended metadata
  description?: string
  version?: string

  // Author information
  author?: A2UIAppAuthor

  // Classification
  category?: string
  tags?: string[]

  // Thumbnail
  thumbnail?: string
  thumbnailUpdatedAt?: number

  // Statistics (for app store)
  stats?: A2UIAppStats

  // App store metadata
  publishedAt?: number
  isPublished?: boolean
  storeId?: string

  // Screenshots (for app store)
  screenshots?: string[]
}
