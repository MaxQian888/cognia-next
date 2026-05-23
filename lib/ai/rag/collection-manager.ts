/**
 * RAG Collection Manager
 *
 * Unified collection management for RAG operations.
 * Coordinates between in-memory and persistent storage.
 *
 * Features:
 * - CRUD operations for collections
 * - Collection configuration management
 * - Statistics and monitoring
 * - Backup and restore
 * - Migration support
 */

import {
  PersistentRAGStorage,
  createPersistentStorage,
  type StoredCollection as _StoredCollection,
} from "./persistent-storage"
import { loggers } from "@/lib/logging"

const log = loggers.ai

export interface CollectionConfig {
  name: string
  description?: string
  chunkingStrategy: string
  chunkSize: number
  chunkOverlap: number
  embeddingModel: string
  metadata?: Record<string, unknown>
}

export interface CollectionStats {
  name: string
  documentCount: number
  chunkCount: number
  averageChunkSize: number
  storageSize: number
  lastUpdated: number
  createdAt: number
}

export interface CollectionInfo {
  config: CollectionConfig
  stats: CollectionStats
  exists: boolean
}

export interface CollectionManagerConfig {
  enablePersistence: boolean
  autoSave: boolean
  saveInterval: number // milliseconds
}

const DEFAULT_CONFIG: CollectionManagerConfig = {
  enablePersistence: true,
  autoSave: true,
  saveInterval: 5000,
}

const DEFAULT_COLLECTION_CONFIG: Omit<CollectionConfig, "name"> = {
  chunkingStrategy: "semantic",
  chunkSize: 1000,
  chunkOverlap: 200,
  embeddingModel: "text-embedding-3-small",
}

/**
 * RAG Collection Manager
 */
export class RAGCollectionManager {
  private config: CollectionManagerConfig
  private storage: PersistentRAGStorage | null = null
  private collections: Map<string, CollectionConfig> = new Map()
  private stats: Map<string, CollectionStats> = new Map()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSave = false
  private initialized = false

  constructor(config: Partial<CollectionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Initialize the collection manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.config.enablePersistence) {
      this.storage = createPersistentStorage()
      await this.storage.initialize()
      await this.loadFromStorage()
    }

    if (this.config.autoSave) {
      this.startAutoSave()
    }

    this.initialized = true
  }

  /**
   * Load collections from persistent storage
   */
  private async loadFromStorage(): Promise<void> {
    if (!this.storage) return

    const storedCollections = await this.storage.listCollections()

    for (const stored of storedCollections) {
      const config: CollectionConfig = {
        name: stored.name,
        ...DEFAULT_COLLECTION_CONFIG,
        ...(stored.config as Partial<CollectionConfig>),
      }

      this.collections.set(stored.name, config)

      this.stats.set(stored.name, {
        name: stored.name,
        documentCount: stored.documentCount,
        chunkCount: stored.totalChunks,
        averageChunkSize: 0,
        storageSize: stored.totalChunks * 1024, // Estimate
        lastUpdated: stored.updatedAt,
        createdAt: stored.createdAt,
      })
    }
  }

  /**
   * Start auto-save timer
   */
  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      if (this.pendingSave) {
        this.saveToStorage().catch((e) =>
          log.warn("Failed to save to storage", { error: String(e) })
        )
        this.pendingSave = false
      }
    }, this.config.saveInterval)
  }

  /**
   * Save collections to persistent storage
   */
  private async saveToStorage(): Promise<void> {
    if (!this.storage) return

    for (const [name, config] of this.collections.entries()) {
      const stats = this.stats.get(name)
      const now = Date.now()
      await this.storage.saveCollectionConfig({
        name,
        documentCount: stats?.documentCount ?? 0,
        totalChunks: stats?.chunkCount ?? 0,
        createdAt: stats?.createdAt ?? now,
        updatedAt: now,
        config: config as unknown as Record<string, unknown>,
      })
    }
  }

  /**
   * Mark for pending save
   */
  private markPendingSave(): void {
    this.pendingSave = true
  }

  /**
   * Create a new collection
   */
  async createCollection(
    name: string,
    config: Partial<Omit<CollectionConfig, "name">> = {}
  ): Promise<CollectionInfo> {
    if (this.collections.has(name)) {
      throw new Error(`Collection "${name}" already exists`)
    }

    const now = Date.now()
    const collectionConfig: CollectionConfig = {
      name,
      ...DEFAULT_COLLECTION_CONFIG,
      ...config,
    }

    this.collections.set(name, collectionConfig)

    const stats: CollectionStats = {
      name,
      documentCount: 0,
      chunkCount: 0,
      averageChunkSize: 0,
      storageSize: 0,
      lastUpdated: now,
      createdAt: now,
    }

    this.stats.set(name, stats)
    this.markPendingSave()

    return {
      config: collectionConfig,
      stats,
      exists: true,
    }
  }

  /**
   * Delete a collection
   */
  async deleteCollection(name: string): Promise<boolean> {
    if (!this.collections.has(name)) {
      return false
    }

    if (this.storage) {
      await this.storage.clearCollection(name)
    }

    this.collections.delete(name)
    this.stats.delete(name)
    this.markPendingSave()

    return true
  }

  /**
   * Update collection configuration
   */
  async updateCollection(
    name: string,
    updates: Partial<Omit<CollectionConfig, "name">>
  ): Promise<CollectionConfig | null> {
    const existing = this.collections.get(name)
    if (!existing) return null

    const updated: CollectionConfig = {
      ...existing,
      ...updates,
      name, // Ensure name can't be changed
    }

    this.collections.set(name, updated)

    // Update stats timestamp
    const stats = this.stats.get(name)
    if (stats) {
      stats.lastUpdated = Date.now()
    }

    this.markPendingSave()
    return updated
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(name: string): Promise<CollectionInfo | null> {
    const config = this.collections.get(name)
    if (!config) return null

    const stats = this.stats.get(name) || {
      name,
      documentCount: 0,
      chunkCount: 0,
      averageChunkSize: 0,
      storageSize: 0,
      lastUpdated: Date.now(),
      createdAt: Date.now(),
    }

    return {
      config,
      stats,
      exists: true,
    }
  }

  /**
   * Get collection stats
   */
  async getCollectionStats(name: string): Promise<CollectionStats | null> {
    return this.stats.get(name) || null
  }

  /**
   * List all collections
   */
  async listCollections(): Promise<CollectionInfo[]> {
    const result: CollectionInfo[] = []

    for (const [name, config] of this.collections) {
      const stats = this.stats.get(name)
      result.push({
        config,
        stats: stats || {
          name,
          documentCount: 0,
          chunkCount: 0,
          averageChunkSize: 0,
          storageSize: 0,
          lastUpdated: Date.now(),
          createdAt: Date.now(),
        },
        exists: true,
      })
    }

    return result
  }

  /**
   * Check if collection exists
   */
  hasCollection(name: string): boolean {
    return this.collections.has(name)
  }

  /**
   * Update collection stats after indexing
   */
  updateStats(
    name: string,
    updates: Partial<
      Pick<CollectionStats, "documentCount" | "chunkCount" | "averageChunkSize" | "storageSize">
    >
  ): void {
    const existing = this.stats.get(name)
    if (!existing) return

    Object.assign(existing, updates, { lastUpdated: Date.now() })
    this.markPendingSave()
  }

  /**
   * Increment document count
   */
  incrementDocumentCount(name: string, count: number = 1): void {
    const stats = this.stats.get(name)
    if (stats) {
      stats.documentCount += count
      stats.lastUpdated = Date.now()
      this.markPendingSave()
    }
  }

  /**
   * Increment chunk count
   */
  incrementChunkCount(name: string, count: number = 1): void {
    const stats = this.stats.get(name)
    if (stats) {
      stats.chunkCount += count
      stats.lastUpdated = Date.now()
      this.markPendingSave()
    }
  }

  /**
   * Get aggregate statistics for all collections
   */
  async getAggregateStats(): Promise<{
    totalCollections: number
    totalDocuments: number
    totalChunks: number
    totalStorageSize: number
  }> {
    let totalDocuments = 0
    let totalChunks = 0
    let totalStorageSize = 0

    for (const stats of this.stats.values()) {
      totalDocuments += stats.documentCount
      totalChunks += stats.chunkCount
      totalStorageSize += stats.storageSize
    }

    return {
      totalCollections: this.collections.size,
      totalDocuments,
      totalChunks,
      totalStorageSize,
    }
  }

  /**
   * Export collection configuration
   */
  exportConfig(name: string): CollectionConfig | null {
    return this.collections.get(name) || null
  }

  /**
   * Export all configurations
   */
  exportAllConfigs(): CollectionConfig[] {
    return Array.from(this.collections.values())
  }

  /**
   * Import collection configuration
   */
  async importConfig(config: CollectionConfig): Promise<void> {
    this.collections.set(config.name, config)

    if (!this.stats.has(config.name)) {
      const now = Date.now()
      this.stats.set(config.name, {
        name: config.name,
        documentCount: 0,
        chunkCount: 0,
        averageChunkSize: 0,
        storageSize: 0,
        lastUpdated: now,
        createdAt: now,
      })
    }

    this.markPendingSave()
  }

  /**
   * Rename a collection
   */
  async renameCollection(oldName: string, newName: string): Promise<boolean> {
    if (!this.collections.has(oldName) || this.collections.has(newName)) {
      return false
    }

    const config = this.collections.get(oldName)!
    const stats = this.stats.get(oldName)

    // Update config with new name
    const newConfig = { ...config, name: newName }
    this.collections.set(newName, newConfig)
    this.collections.delete(oldName)

    // Update stats
    if (stats) {
      const newStats = { ...stats, name: newName }
      this.stats.set(newName, newStats)
      this.stats.delete(oldName)
    }

    // If using persistent storage, we need to migrate documents
    // This is a complex operation that should be done carefully

    this.markPendingSave()
    return true
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }

    if (this.pendingSave) {
      await this.saveToStorage()
    }

    if (this.storage) {
      this.storage.close()
      this.storage = null
    }

    this.collections.clear()
    this.stats.clear()
    this.initialized = false
  }
}

/**
 * Create a collection manager instance
 */
export function createCollectionManager(
  config: Partial<CollectionManagerConfig> = {}
): RAGCollectionManager {
  return new RAGCollectionManager(config)
}

/**
 * Singleton instance for global use
 */
let globalManager: RAGCollectionManager | null = null

export async function getGlobalCollectionManager(): Promise<RAGCollectionManager> {
  if (!globalManager) {
    globalManager = new RAGCollectionManager()
    await globalManager.initialize()
  }
  return globalManager
}

export async function resetGlobalCollectionManager(): Promise<void> {
  if (globalManager) {
    await globalManager.destroy()
    globalManager = null
  }
}
