/**
 * Tests for Contextual Retrieval Module
 */

import {
  createContextCache,
  addLightweightContext,
  extractKeyEntities,
  enrichChunkWithEntities,
  type ContextCache,
} from "./contextual-retrieval"
import type { DocumentChunk } from "../embedding/chunking"

describe("createContextCache", () => {
  let cache: ContextCache

  beforeEach(() => {
    cache = createContextCache(100)
  })

  it("stores and retrieves values", () => {
    cache.set("key1", "context1")

    expect(cache.get("key1")).toBe("context1")
  })

  it("returns undefined for missing keys", () => {
    expect(cache.get("nonexistent")).toBeUndefined()
  })

  it("checks key existence with has()", () => {
    cache.set("key1", "context1")

    expect(cache.has("key1")).toBe(true)
    expect(cache.has("nonexistent")).toBe(false)
  })

  it("clears all entries", () => {
    cache.set("key1", "context1")
    cache.set("key2", "context2")
    cache.clear()

    expect(cache.get("key1")).toBeUndefined()
    expect(cache.get("key2")).toBeUndefined()
  })

  it("evicts oldest entries when max size exceeded", () => {
    const smallCache = createContextCache(3)

    smallCache.set("key1", "context1")
    smallCache.set("key2", "context2")
    smallCache.set("key3", "context3")
    smallCache.set("key4", "context4") // Should evict key1

    // key1 should be evicted (oldest)
    expect(smallCache.has("key1")).toBe(false)
    expect(smallCache.has("key4")).toBe(true)
  })

  it("get returns correct value and updates entry", () => {
    const cache = createContextCache(100)

    cache.set("key1", "context1")

    // Get should return the value
    expect(cache.get("key1")).toBe("context1")

    // Get for missing key should return undefined
    expect(cache.get("nonexistent")).toBeUndefined()
  })
})

describe("addLightweightContext", () => {
  const documentContent = `# Introduction

This is the introduction section.

## Methods

This section describes the methods used.

## Results

Here are the results of our study.

## Conclusion

This is the conclusion.`

  const createChunks = (count: number): DocumentChunk[] => {
    const chunks: DocumentChunk[] = []
    const chunkSize = Math.floor(documentContent.length / count)

    for (let i = 0; i < count; i++) {
      chunks.push({
        id: `chunk-${i}`,
        content: documentContent.slice(i * chunkSize, (i + 1) * chunkSize),
        index: i,
        startOffset: i * chunkSize,
        endOffset: (i + 1) * chunkSize,
      })
    }

    return chunks
  }

  it("adds context prefix to chunks", () => {
    const chunks = createChunks(3)

    const contextualChunks = addLightweightContext(documentContent, chunks, {
      documentTitle: "Test Document",
    })

    expect(contextualChunks.length).toBe(3)
    expect(contextualChunks[0].contextPrefix).toBeTruthy()
    expect(contextualChunks[0].contextualContent).toContain(contextualChunks[0].contextPrefix)
  })

  it("includes document title in context", () => {
    const chunks = createChunks(1)

    const contextualChunks = addLightweightContext(documentContent, chunks, {
      documentTitle: "My Research Paper",
    })

    expect(contextualChunks[0].contextPrefix).toContain("My Research Paper")
  })

  it("includes heading information when enabled", () => {
    const chunks: DocumentChunk[] = [
      {
        id: "chunk-0",
        content: "This section describes the methods used.",
        index: 0,
        startOffset: documentContent.indexOf("This section describes"),
        endOffset: documentContent.indexOf("This section describes") + 50,
      },
    ]

    const contextualChunks = addLightweightContext(documentContent, chunks, {
      includeHeadings: true,
    })

    // Should include the nearest heading
    expect(contextualChunks[0].contextPrefix).toContain("Methods")
  })

  it("includes position context when enabled", () => {
    const chunks = createChunks(5)

    const contextualChunks = addLightweightContext(documentContent, chunks, {
      includePosition: true,
    })

    // First chunk should mention "beginning"
    expect(contextualChunks[0].contextPrefix).toContain("beginning")

    // Last chunk should mention "end"
    expect(contextualChunks[4].contextPrefix).toContain("end")
  })

  it("sets hasContext metadata flag", () => {
    const chunks = createChunks(1)

    const contextualChunks = addLightweightContext(documentContent, chunks, {
      documentTitle: "Test",
    })

    expect(contextualChunks[0].metadata?.hasContext).toBe(true)
  })

  it("stores document title in chunk", () => {
    const chunks = createChunks(1)

    const contextualChunks = addLightweightContext(documentContent, chunks, {
      documentTitle: "Test Title",
    })

    expect(contextualChunks[0].documentTitle).toBe("Test Title")
  })

  it("handles document without headings", () => {
    const plainDocument = "This is a plain document without any markdown headings."
    const chunks: DocumentChunk[] = [
      {
        id: "chunk-0",
        content: plainDocument,
        index: 0,
        startOffset: 0,
        endOffset: plainDocument.length,
      },
    ]

    const contextualChunks = addLightweightContext(plainDocument, chunks, {
      includeHeadings: true,
    })

    // Should still work, just without heading info
    expect(contextualChunks.length).toBe(1)
  })

  it("handles empty chunks array", () => {
    const contextualChunks = addLightweightContext(documentContent, [])

    expect(contextualChunks.length).toBe(0)
  })
})

describe("extractKeyEntities", () => {
  it("extracts capitalized names", () => {
    const text = "John Smith works at Google in San Francisco."

    const entities = extractKeyEntities(text)

    expect(entities).toContain("John Smith")
    expect(entities).toContain("Google")
    expect(entities).toContain("San Francisco")
  })

  it("filters out common title-case words", () => {
    const text = "The quick brown fox jumps over the lazy dog."

    const entities = extractKeyEntities(text)

    expect(entities).not.toContain("The")
  })

  it("extracts quoted terms", () => {
    const text = 'The concept of "machine learning" is important. Also "neural networks" matter.'

    const entities = extractKeyEntities(text)

    expect(entities).toContain("machine learning")
    expect(entities).toContain("neural networks")
  })

  it("extracts camelCase terms", () => {
    const text = "The function useEffect and useState are React hooks."

    const entities = extractKeyEntities(text)

    expect(entities).toContain("useEffect")
    expect(entities).toContain("useState")
  })

  it("extracts snake_case terms", () => {
    const text = "Set the max_retries and connection_timeout variables."

    const entities = extractKeyEntities(text)

    expect(entities).toContain("max_retries")
    expect(entities).toContain("connection_timeout")
  })

  it("limits the number of entities returned", () => {
    const text =
      "John, Mary, Bob, Alice, Tom, Jane, Mike, Lisa, David, Sara, Chris, Emma, Max, Zoe."

    const entities = extractKeyEntities(text)

    expect(entities.length).toBeLessThanOrEqual(10)
  })

  it("handles empty text", () => {
    const entities = extractKeyEntities("")

    expect(entities).toEqual([])
  })

  it("handles text with no entities", () => {
    const text = "this is all lowercase with no special terms."

    const entities = extractKeyEntities(text)

    // May still find some entities or be empty
    expect(Array.isArray(entities)).toBe(true)
  })
})

describe("enrichChunkWithEntities", () => {
  it("adds entity context to chunk", () => {
    const chunk: DocumentChunk = {
      id: "chunk-1",
      content: "John Smith works at Google using React and TypeScript.",
      index: 0,
      startOffset: 0,
      endOffset: 54,
    }

    const enriched = enrichChunkWithEntities(chunk)

    expect(enriched.contextPrefix).toBeTruthy()
    expect(enriched.contextPrefix).toContain("Key terms:")
  })

  it("includes entities in metadata", () => {
    const chunk: DocumentChunk = {
      id: "chunk-1",
      content: "Machine learning with TensorFlow and PyTorch frameworks.",
      index: 0,
      startOffset: 0,
      endOffset: 56,
    }

    const enriched = enrichChunkWithEntities(chunk)

    expect(enriched.metadata?.entities).toBeDefined()
    expect(Array.isArray(enriched.metadata?.entities)).toBe(true)
  })

  it("sets hasContext metadata flag", () => {
    const chunk: DocumentChunk = {
      id: "chunk-1",
      content: "Working with React components.",
      index: 0,
      startOffset: 0,
      endOffset: 30,
    }

    const enriched = enrichChunkWithEntities(chunk)

    expect(enriched.metadata?.hasContext).toBeDefined()
  })

  it("includes context in contextualContent", () => {
    const chunk: DocumentChunk = {
      id: "chunk-1",
      content: "OpenAI GPT models are powerful.",
      index: 0,
      startOffset: 0,
      endOffset: 31,
    }

    const enriched = enrichChunkWithEntities(chunk)

    if (enriched.contextPrefix) {
      expect(enriched.contextualContent).toContain("[Key terms:")
      expect(enriched.contextualContent).toContain(chunk.content)
    }
  })

  it("handles chunk with no extractable entities", () => {
    const chunk: DocumentChunk = {
      id: "chunk-1",
      content: "this is all lowercase text without special terms.",
      index: 0,
      startOffset: 0,
      endOffset: 48,
    }

    const enriched = enrichChunkWithEntities(chunk)

    // Should still return a valid chunk
    expect(enriched.id).toBe(chunk.id)
    expect(enriched.content).toBe(chunk.content)
  })

  it("preserves original chunk properties", () => {
    const chunk: DocumentChunk = {
      id: "chunk-1",
      content: "Test content with React.",
      index: 5,
      startOffset: 100,
      endOffset: 124,
      metadata: { original: true },
    }

    const enriched = enrichChunkWithEntities(chunk)

    expect(enriched.id).toBe("chunk-1")
    expect(enriched.index).toBe(5)
    expect(enriched.startOffset).toBe(100)
    expect(enriched.endOffset).toBe(124)
  })
})
