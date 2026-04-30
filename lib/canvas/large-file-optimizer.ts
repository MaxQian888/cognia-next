/**
 * Large File Optimizer - Chunk-based storage and lazy loading for large files
 * Optimizes memory usage and rendering performance for files over 10,000 lines
 */

export interface ChunkedDocument {
  id: string
  chunks: string[]
  chunkSize: number
  totalLength: number
  lineCount: number
  lineOffsets: number[]
}

export interface DocumentIndex {
  lineToChunk: Map<number, number>
  chunkToLines: Map<number, { start: number; end: number }>
  symbolIndex: Map<string, number[]>
}

export interface ChunkRange {
  startChunk: number
  endChunk: number
  content: string
}

const DEFAULT_CHUNK_SIZE = 10000
const LARGE_FILE_THRESHOLD = 50000

export class LargeFileOptimizer {
  private chunkSize: number

  constructor(chunkSize: number = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = chunkSize
  }

  /**
   * Check if a file should be treated as large
   */
  isLargeFile(content: string): boolean {
    return content.length > LARGE_FILE_THRESHOLD
  }

  /**
   * Split content into chunks for efficient storage
   */
  chunkContent(id: string, content: string): ChunkedDocument {
    const chunks: string[] = []
    const lineOffsets: number[] = [0]

    let lineCount = 1
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") {
        lineOffsets.push(i + 1)
        lineCount++
      }
    }

    for (let i = 0; i < content.length; i += this.chunkSize) {
      chunks.push(content.slice(i, i + this.chunkSize))
    }

    return {
      id,
      chunks,
      chunkSize: this.chunkSize,
      totalLength: content.length,
      lineCount,
      lineOffsets,
    }
  }

  /**
   * Reassemble content from chunks
   */
  assembleContent(document: ChunkedDocument): string {
    return document.chunks.join("")
  }

  /**
   * Get content for a specific line range (lazy loading)
   */
  getChunkRange(document: ChunkedDocument, startLine: number, endLine: number): string {
    const startOffset = document.lineOffsets[Math.max(0, startLine - 1)] || 0
    const endOffset =
      document.lineOffsets[Math.min(endLine, document.lineCount - 1)] || document.totalLength

    const startChunk = Math.floor(startOffset / document.chunkSize)
    const endChunk = Math.floor(endOffset / document.chunkSize)

    let content = ""
    for (let i = startChunk; i <= endChunk && i < document.chunks.length; i++) {
      content += document.chunks[i]
    }

    const relativeStart = startOffset - startChunk * document.chunkSize
    const relativeEnd = endOffset - startChunk * document.chunkSize

    return content.slice(relativeStart, relativeEnd)
  }

  /**
   * Build an incremental index for faster navigation
   */
  buildIncrementalIndex(content: string): DocumentIndex {
    const lineToChunk = new Map<number, number>()
    const chunkToLines = new Map<number, { start: number; end: number }>()
    const symbolIndex = new Map<string, number[]>()

    const lines = content.split("\n")
    let currentOffset = 0
    let currentChunk = 0
    let chunkStartLine = 0

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum]
      const chunkIndex = Math.floor(currentOffset / this.chunkSize)

      if (chunkIndex !== currentChunk) {
        chunkToLines.set(currentChunk, { start: chunkStartLine, end: lineNum - 1 })
        currentChunk = chunkIndex
        chunkStartLine = lineNum
      }

      lineToChunk.set(lineNum, chunkIndex)

      const symbols = this.extractSymbols(line)
      for (const symbol of symbols) {
        const existing = symbolIndex.get(symbol) || []
        existing.push(lineNum)
        symbolIndex.set(symbol, existing)
      }

      currentOffset += line.length + 1
    }

    chunkToLines.set(currentChunk, { start: chunkStartLine, end: lines.length - 1 })

    return { lineToChunk, chunkToLines, symbolIndex }
  }

  /**
   * Extract symbol names from a line of code
   */
  private extractSymbols(line: string): string[] {
    const symbols: string[] = []

    const functionMatch = line.match(/(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/)
    if (functionMatch) {
      symbols.push(functionMatch[1])
    }

    const methodMatch = line.match(/(\w+)\s*[=:]\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/)
    if (methodMatch) {
      symbols.push(methodMatch[1])
    }

    const exportMatch = line.match(
      /export\s+(?:default\s+)?(?:function|const|class|interface|type)\s+(\w+)/
    )
    if (exportMatch) {
      symbols.push(exportMatch[1])
    }

    return symbols
  }

  /**
   * Update a chunk with new content (for incremental edits)
   */
  updateChunk(document: ChunkedDocument, chunkIndex: number, newContent: string): ChunkedDocument {
    const chunks = [...document.chunks]
    chunks[chunkIndex] = newContent

    const fullContent = chunks.join("")
    return this.chunkContent(document.id, fullContent)
  }

  /**
   * Get visible content with buffer for smooth scrolling
   */
  getVisibleContent(
    document: ChunkedDocument,
    visibleStartLine: number,
    visibleEndLine: number,
    bufferLines: number = 50
  ): { content: string; startLine: number; endLine: number } {
    const startLine = Math.max(0, visibleStartLine - bufferLines)
    const endLine = Math.min(document.lineCount, visibleEndLine + bufferLines)

    return {
      content: this.getChunkRange(document, startLine, endLine),
      startLine,
      endLine,
    }
  }

  /**
   * Compute diff between old and new content efficiently
   */
  computeChunkDiff(
    oldDocument: ChunkedDocument,
    newContent: string
  ): { changedChunks: number[]; newDocument: ChunkedDocument } {
    const newDocument = this.chunkContent(oldDocument.id, newContent)
    const changedChunks: number[] = []

    const maxChunks = Math.max(oldDocument.chunks.length, newDocument.chunks.length)
    for (let i = 0; i < maxChunks; i++) {
      if (oldDocument.chunks[i] !== newDocument.chunks[i]) {
        changedChunks.push(i)
      }
    }

    return { changedChunks, newDocument }
  }
}

export const largeFileOptimizer = new LargeFileOptimizer()

export default LargeFileOptimizer
