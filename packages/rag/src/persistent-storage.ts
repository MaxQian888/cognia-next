/**
 * Persistent RAG Storage
 *
 * IndexedDB-based persistent storage for RAG collections.
 * Enables cross-session persistence and large collection support.
 *
 * Features:
 * - IndexedDB-based storage
 * - Collection management
 * - Document versioning
 * - Export/import functionality
 * - Compression support
 */

export interface StoredDocument {
  id: string
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
  version: number
  createdAt: number
  updatedAt: number
}

export interface StoredCollection {
  name: string
  documentCount: number
  totalChunks: number
  createdAt: number
  updatedAt: number
  config?: Record<string, unknown>
}

export interface PersistentStorageConfig {
  dbName: string
  version: number
  collectionsStore: string
  documentsStore: string
  metadataStore: string
  enableCompression: boolean
}

export interface ExportData {
  version: string
  exportedAt: number
  collections: StoredCollection[]
  documents: Map<string, StoredDocument[]>
}

const DEFAULT_CONFIG: PersistentStorageConfig = {
  dbName: "cognia-rag-storage",
  version: 1,
  collectionsStore: "collections",
  documentsStore: "documents",
  metadataStore: "metadata",
  enableCompression: false,
}

/**
 * Persistent RAG Storage using IndexedDB
 */
export class PersistentRAGStorage {
  private config: PersistentStorageConfig
  private db: IDBDatabase | null = null
  private initialized = false

  constructor(config: Partial<PersistentStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Initialize the storage
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available")
    }

    this.db = await this.openDatabase()
    this.initialized = true
  }

  /**
   * Open IndexedDB database
   */
  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.config.dbName, this.config.version)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Collections store
        if (!db.objectStoreNames.contains(this.config.collectionsStore)) {
          db.createObjectStore(this.config.collectionsStore, { keyPath: "name" })
        }

        // Documents store with indexes
        if (!db.objectStoreNames.contains(this.config.documentsStore)) {
          const docStore = db.createObjectStore(this.config.documentsStore, { keyPath: "id" })
          docStore.createIndex("collection", "collectionName", { unique: false })
          docStore.createIndex("documentId", "documentId", { unique: false })
        }

        // Metadata store
        if (!db.objectStoreNames.contains(this.config.metadataStore)) {
          db.createObjectStore(this.config.metadataStore, { keyPath: "key" })
        }
      }
    })
  }

  /**
   * Ensure database is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error("Storage not initialized. Call initialize() first.")
    }
  }

  /**
   * Save documents to a collection
   */
  async saveDocuments(
    collectionName: string,
    documents: Omit<StoredDocument, "version" | "createdAt" | "updatedAt">[]
  ): Promise<void> {
    this.ensureInitialized()

    const now = Date.now()
    const docsWithMeta: (StoredDocument & { collectionName: string })[] = documents.map((doc) => ({
      ...doc,
      collectionName,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }))

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.config.documentsStore, this.config.collectionsStore],
        "readwrite"
      )

      const docStore = transaction.objectStore(this.config.documentsStore)
      const colStore = transaction.objectStore(this.config.collectionsStore)

      // Save documents
      for (const doc of docsWithMeta) {
        docStore.put(doc)
      }

      // Update collection metadata
      const colRequest = colStore.get(collectionName)
      colRequest.onsuccess = () => {
        const existing = colRequest.result as StoredCollection | undefined
        const collection: StoredCollection = {
          name: collectionName,
          documentCount: (existing?.documentCount || 0) + documents.length,
          totalChunks: (existing?.totalChunks || 0) + documents.length,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        }
        colStore.put(collection)
      }

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * Load documents from a collection
   */
  async loadDocuments(collectionName: string): Promise<StoredDocument[]> {
    this.ensureInitialized()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.documentsStore, "readonly")
      const store = transaction.objectStore(this.config.documentsStore)
      const index = store.index("collection")
      const request = index.getAll(collectionName)

      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Delete documents from a collection
   */
  async deleteDocuments(collectionName: string, documentIds: string[]): Promise<number> {
    this.ensureInitialized()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.config.documentsStore, this.config.collectionsStore],
        "readwrite"
      )

      const docStore = transaction.objectStore(this.config.documentsStore)
      let deleted = 0

      for (const id of documentIds) {
        const request = docStore.delete(id)
        request.onsuccess = () => deleted++
      }

      // Update collection count
      const colStore = transaction.objectStore(this.config.collectionsStore)
      const colRequest = colStore.get(collectionName)
      colRequest.onsuccess = () => {
        const existing = colRequest.result as StoredCollection | undefined
        if (existing) {
          existing.documentCount = Math.max(0, existing.documentCount - deleted)
          existing.totalChunks = Math.max(0, existing.totalChunks - deleted)
          existing.updatedAt = Date.now()
          colStore.put(existing)
        }
      }

      transaction.oncomplete = () => resolve(deleted)
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * Clear a collection
   */
  async clearCollection(collectionName: string): Promise<void> {
    this.ensureInitialized()

    // First get all document IDs in the collection
    const docs = await this.loadDocuments(collectionName)
    const ids = docs.map((d) => d.id)

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [this.config.documentsStore, this.config.collectionsStore],
        "readwrite"
      )

      const docStore = transaction.objectStore(this.config.documentsStore)

      // Delete all documents
      for (const id of ids) {
        docStore.delete(id)
      }

      // Delete collection metadata
      const colStore = transaction.objectStore(this.config.collectionsStore)
      colStore.delete(collectionName)

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * List all collections
   */
  async listCollections(): Promise<StoredCollection[]> {
    this.ensureInitialized()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.collectionsStore, "readonly")
      const store = transaction.objectStore(this.config.collectionsStore)
      const request = store.getAll()

      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(collectionName: string): Promise<StoredCollection | null> {
    this.ensureInitialized()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.collectionsStore, "readonly")
      const store = transaction.objectStore(this.config.collectionsStore)
      const request = store.get(collectionName)

      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Save or update collection config
   */
  async saveCollectionConfig(collection: StoredCollection): Promise<void> {
    this.ensureInitialized()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.collectionsStore, "readwrite")
      const store = transaction.objectStore(this.config.collectionsStore)
      store.put(collection)

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * Update a document
   */
  async updateDocument(
    collectionName: string,
    documentId: string,
    updates: Partial<Pick<StoredDocument, "content" | "embedding" | "metadata">>
  ): Promise<boolean> {
    this.ensureInitialized()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.documentsStore, "readwrite")
      const store = transaction.objectStore(this.config.documentsStore)
      const getRequest = store.get(documentId)

      getRequest.onsuccess = () => {
        const existing = getRequest.result as
          | (StoredDocument & { collectionName: string })
          | undefined
        if (!existing || existing.collectionName !== collectionName) {
          resolve(false)
          return
        }

        const updated = {
          ...existing,
          ...updates,
          version: existing.version + 1,
          updatedAt: Date.now(),
        }

        store.put(updated)
      }

      transaction.oncomplete = () => resolve(true)
      transaction.onerror = () => reject(transaction.error)
    })
  }

  /**
   * Export all data
   */
  async exportAll(): Promise<ExportData> {
    this.ensureInitialized()

    const collections = await this.listCollections()
    const documents = new Map<string, StoredDocument[]>()

    for (const collection of collections) {
      const docs = await this.loadDocuments(collection.name)
      documents.set(collection.name, docs)
    }

    return {
      version: "1.0",
      exportedAt: Date.now(),
      collections,
      documents,
    }
  }

  /**
   * Import data
   */
  async importData(data: ExportData): Promise<{ collections: number; documents: number }> {
    this.ensureInitialized()

    let collectionCount = 0
    let documentCount = 0

    for (const collection of data.collections) {
      const docs = data.documents.get(collection.name) || []
      await this.saveDocuments(collection.name, docs)
      collectionCount++
      documentCount += docs.length
    }

    return { collections: collectionCount, documents: documentCount }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    collections: number
    totalDocuments: number
    estimatedSize: number
  }> {
    this.ensureInitialized()

    const collections = await this.listCollections()
    let totalDocuments = 0
    let estimatedSize = 0

    for (const collection of collections) {
      totalDocuments += collection.documentCount
      // Rough estimate: ~1KB per chunk + embedding size
      estimatedSize += collection.totalChunks * 1024
    }

    return {
      collections: collections.length,
      totalDocuments,
      estimatedSize,
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.initialized = false
    }
  }

  /**
   * Delete the entire database
   */
  async deleteDatabase(): Promise<void> {
    this.close()

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.config.dbName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
}

/**
 * Create a persistent storage instance
 */
export function createPersistentStorage(
  config: Partial<PersistentStorageConfig> = {}
): PersistentRAGStorage {
  return new PersistentRAGStorage(config)
}

/**
 * Check if IndexedDB is available
 */
export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== "undefined"
}

/**
 * Get storage estimate
 */
export async function getStorageEstimate(): Promise<{
  usage: number
  quota: number
  usagePercent: number
} | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return null
  }

  try {
    const estimate = await navigator.storage.estimate()
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      usagePercent: estimate.quota ? ((estimate.usage || 0) / estimate.quota) * 100 : 0,
    }
  } catch {
    return null
  }
}
