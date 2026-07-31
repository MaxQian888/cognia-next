/**
 * Embedding Batch Optimizer
 *
 * Optimizes embedding generation by batching requests
 * and managing parallel processing efficiently.
 *
 * Features:
 * - Request batching with configurable size
 * - Automatic flush on timeout
 * - Parallel batch processing
 * - Queue management with priority
 * - Rate limiting support
 */

import type { EmbeddingModelConfig } from "@cognia/vector/embedding"
import { generateEmbeddings as baseGenerateEmbeddings } from "@cognia/vector/embedding"

export interface BatcherConfig {
  batchSize: number
  flushInterval: number // milliseconds
  maxParallelBatches: number
  retryAttempts: number
  retryDelay: number // milliseconds
  enabled: boolean
}

export interface BatchRequest {
  text: string
  priority: number
  resolve: (embedding: number[]) => void
  reject: (error: Error) => void
  timestamp: number
}

export interface BatcherStats {
  totalRequests: number
  batchesProcessed: number
  averageBatchSize: number
  averageLatency: number
  errors: number
  retries: number
  queueSize: number
}

const DEFAULT_CONFIG: BatcherConfig = {
  batchSize: 50,
  flushInterval: 100, // 100ms
  maxParallelBatches: 3,
  retryAttempts: 3,
  retryDelay: 1000, // 1 second
  enabled: true,
}

/**
 * Embedding Batcher - Optimizes embedding generation with batching
 */
export class EmbeddingBatcher {
  private config: BatcherConfig
  private embeddingConfig: EmbeddingModelConfig
  private apiKey: string

  private queue: BatchRequest[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeBatches = 0
  private processing = false

  private stats = {
    totalRequests: 0,
    batchesProcessed: 0,
    totalBatchSize: 0,
    totalLatency: 0,
    errors: 0,
    retries: 0,
  }

  constructor(
    embeddingConfig: EmbeddingModelConfig,
    apiKey: string,
    config: Partial<BatcherConfig> = {}
  ) {
    this.embeddingConfig = embeddingConfig
    this.apiKey = apiKey
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Queue a single text for embedding generation
   */
  async generateEmbedding(text: string, priority: number = 0): Promise<number[]> {
    if (!this.config.enabled) {
      const result = await baseGenerateEmbeddings([text], this.embeddingConfig, this.apiKey)
      return result.embeddings[0]
    }

    return new Promise((resolve, reject) => {
      const request: BatchRequest = {
        text,
        priority,
        resolve,
        reject,
        timestamp: Date.now(),
      }

      this.queue.push(request)
      this.stats.totalRequests++

      // Sort by priority (higher priority first)
      this.queue.sort((a, b) => b.priority - a.priority)

      // Start flush timer if not running
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.config.flushInterval)
      }

      // Immediate flush if batch is full
      if (this.queue.length >= this.config.batchSize) {
        this.flush()
      }
    })
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateEmbeddings(texts: string[], priority: number = 0): Promise<number[][]> {
    if (!this.config.enabled || texts.length === 0) {
      if (texts.length === 0) return []
      const result = await baseGenerateEmbeddings(texts, this.embeddingConfig, this.apiKey)
      return result.embeddings
    }

    const promises = texts.map((text) => this.generateEmbedding(text, priority))
    return Promise.all(promises)
  }

  /**
   * Flush the queue and process batches
   */
  private async flush(): Promise<void> {
    // Clear the timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // Avoid concurrent flush operations
    if (this.processing) return
    this.processing = true

    try {
      while (this.queue.length > 0 && this.activeBatches < this.config.maxParallelBatches) {
        const batch = this.queue.splice(0, this.config.batchSize)
        if (batch.length > 0) {
          this.activeBatches++
          this.processBatch(batch).finally(() => {
            this.activeBatches--
            // Check if more batches need processing
            if (this.queue.length > 0) {
              this.flush()
            }
          })
        }
      }
    } finally {
      this.processing = false

      // Schedule next flush if there are remaining items
      if (this.queue.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.config.flushInterval)
      }
    }
  }

  /**
   * Process a single batch of requests
   */
  private async processBatch(batch: BatchRequest[]): Promise<void> {
    const startTime = Date.now()
    const texts = batch.map((r) => r.text)

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const result = await baseGenerateEmbeddings(texts, this.embeddingConfig, this.apiKey)

        // Resolve all requests
        for (let i = 0; i < batch.length; i++) {
          batch[i].resolve(result.embeddings[i])
        }

        // Update stats
        this.stats.batchesProcessed++
        this.stats.totalBatchSize += batch.length
        this.stats.totalLatency += Date.now() - startTime

        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        if (attempt < this.config.retryAttempts) {
          this.stats.retries++
          await this.delay(this.config.retryDelay * (attempt + 1))
        }
      }
    }

    // All retries failed, reject all requests
    this.stats.errors++
    for (const request of batch) {
      request.reject(lastError || new Error("Embedding generation failed"))
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get batcher statistics
   */
  getStats(): BatcherStats {
    return {
      totalRequests: this.stats.totalRequests,
      batchesProcessed: this.stats.batchesProcessed,
      averageBatchSize:
        this.stats.batchesProcessed > 0
          ? this.stats.totalBatchSize / this.stats.batchesProcessed
          : 0,
      averageLatency:
        this.stats.batchesProcessed > 0 ? this.stats.totalLatency / this.stats.batchesProcessed : 0,
      errors: this.stats.errors,
      retries: this.stats.retries,
      queueSize: this.queue.length,
    }
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      batchesProcessed: 0,
      totalBatchSize: 0,
      totalLatency: 0,
      errors: 0,
      retries: 0,
    }
  }

  /**
   * Clear the queue (cancels pending requests)
   */
  clearQueue(): number {
    const count = this.queue.length
    const error = new Error("Queue cleared")

    for (const request of this.queue) {
      request.reject(error)
    }

    this.queue = []

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    return count
  }

  /**
   * Wait for all pending requests to complete
   */
  async waitForCompletion(): Promise<void> {
    if (this.queue.length > 0) {
      await this.flush()
    }

    // Wait for active batches
    while (this.activeBatches > 0) {
      await this.delay(50)
    }
  }

  /**
   * Enable or disable batching
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  /**
   * Update batch size
   */
  setBatchSize(size: number): void {
    this.config.batchSize = Math.max(1, size)
  }

  /**
   * Update flush interval
   */
  setFlushInterval(interval: number): void {
    this.config.flushInterval = Math.max(10, interval)
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.length
  }

  /**
   * Check if batcher is processing
   */
  isProcessing(): boolean {
    return this.processing || this.activeBatches > 0
  }
}

/**
 * Optimized batch embedding generator
 *
 * Processes large text arrays efficiently with automatic batching
 */
export async function batchGenerateEmbeddings(
  texts: string[],
  embeddingConfig: EmbeddingModelConfig,
  apiKey: string,
  options: {
    batchSize?: number
    maxParallelBatches?: number
    onProgress?: (progress: { current: number; total: number }) => void
  } = {}
): Promise<{ embeddings: number[][]; stats: { batches: number; totalTime: number } }> {
  const { batchSize = 50, maxParallelBatches = 3, onProgress } = options
  const startTime = Date.now()

  if (texts.length === 0) {
    return { embeddings: [], stats: { batches: 0, totalTime: 0 } }
  }

  const embeddings: number[][] = new Array(texts.length)
  const batches: string[][] = []

  // Split into batches
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize))
  }

  let completed = 0

  // Process batches with limited parallelism
  const processBatch = async (batch: string[], startIdx: number): Promise<void> => {
    const result = await baseGenerateEmbeddings(batch, embeddingConfig, apiKey)

    for (let i = 0; i < batch.length; i++) {
      embeddings[startIdx + i] = result.embeddings[i]
    }

    completed += batch.length
    onProgress?.({ current: completed, total: texts.length })
  }

  // Process with controlled parallelism
  const promises: Promise<void>[] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const startIdx = i * batchSize

    const promise = processBatch(batch, startIdx)
    promises.push(promise)

    // Wait if we've hit the parallel limit
    if (promises.length >= maxParallelBatches) {
      await Promise.race(promises)
      // Remove completed promises
      for (let j = promises.length - 1; j >= 0; j--) {
        const result = await Promise.race([promises[j].then(() => true), Promise.resolve(false)])
        if (result) {
          promises.splice(j, 1)
        }
      }
    }
  }

  // Wait for remaining batches
  await Promise.all(promises)

  return {
    embeddings,
    stats: {
      batches: batches.length,
      totalTime: Date.now() - startTime,
    },
  }
}

/**
 * Create an embedding batcher instance
 */
export function createEmbeddingBatcher(
  embeddingConfig: EmbeddingModelConfig,
  apiKey: string,
  config: Partial<BatcherConfig> = {}
): EmbeddingBatcher {
  return new EmbeddingBatcher(embeddingConfig, apiKey, config)
}

/**
 * Singleton batcher for global use
 */
let globalBatcher: EmbeddingBatcher | null = null

export function getGlobalBatcher(
  embeddingConfig: EmbeddingModelConfig,
  apiKey: string
): EmbeddingBatcher {
  if (!globalBatcher) {
    globalBatcher = new EmbeddingBatcher(embeddingConfig, apiKey)
  }
  return globalBatcher
}

export function resetGlobalBatcher(): void {
  if (globalBatcher) {
    globalBatcher.clearQueue()
    globalBatcher = null
  }
}
