export interface VirtualBlockMetric {
  id: string
  rows: number
}

export interface VirtualBlockIndex {
  blocks: readonly VirtualBlockMetric[]
  /** `prefixRows[i]` is the first row of block i; final item is total rows. */
  prefixRows: readonly number[]
  totalRows: number
  positions: ReadonlyMap<string, number>
}

export interface ViewportAnchor {
  blockId: string
  intraRow: number
}

export interface VirtualWindow {
  start: number
  end: number
  padTop: number
  padBottom: number
  renderedRows: number
}

export function buildVirtualBlockIndex(blocks: readonly VirtualBlockMetric[]): VirtualBlockIndex {
  const prefixRows = [0]
  const positions = new Map<string, number>()
  let totalRows = 0
  blocks.forEach((block, index) => {
    positions.set(block.id, index)
    totalRows += Math.max(1, Math.floor(block.rows))
    prefixRows.push(totalRows)
  })
  return { blocks, prefixRows, totalRows, positions }
}

/** Index of the block containing row, clamped to the available range. */
function blockAtRow(index: VirtualBlockIndex, row: number): number {
  if (index.blocks.length === 0) return -1
  const target = Math.max(0, Math.min(Math.floor(row), Math.max(0, index.totalRows - 1)))
  let low = 0
  let high = index.blocks.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (index.prefixRows[mid + 1] <= target) low = mid + 1
    else high = mid
  }
  return Math.min(low, index.blocks.length - 1)
}

export function anchorAtRow(index: VirtualBlockIndex, row: number): ViewportAnchor | null {
  const blockIndex = blockAtRow(index, row)
  if (blockIndex < 0) return null
  const block = index.blocks[blockIndex]
  const height = index.prefixRows[blockIndex + 1] - index.prefixRows[blockIndex]
  return {
    blockId: block.id,
    intraRow: Math.max(0, Math.min(Math.floor(row) - index.prefixRows[blockIndex], height - 1)),
  }
}

export function rowForAnchor(index: VirtualBlockIndex, anchor: ViewportAnchor | null): number {
  if (!anchor) return 0
  const position = index.positions.get(anchor.blockId)
  if (position === undefined) return 0
  const height = index.prefixRows[position + 1] - index.prefixRows[position]
  return index.prefixRows[position] + Math.max(0, Math.min(Math.floor(anchor.intraRow), height - 1))
}

export function virtualWindow(
  index: VirtualBlockIndex,
  top: number,
  viewportRows: number,
  overscanViewports = 2
): VirtualWindow {
  if (index.blocks.length === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, renderedRows: 0 }
  }
  const viewport = Math.max(1, Math.floor(viewportRows))
  const clampedTop = Math.max(0, Math.min(Math.floor(top), Math.max(0, index.totalRows - viewport)))
  const overscan = Math.max(0, Math.floor(overscanViewports)) * viewport
  const startRow = Math.max(0, clampedTop - overscan)
  const endRow = Math.min(index.totalRows, clampedTop + viewport + overscan)
  const start = blockAtRow(index, startRow)
  const last = blockAtRow(index, Math.max(startRow, endRow - 1))
  const end = last + 1
  const padTop = index.prefixRows[start]
  const renderedRows = index.prefixRows[end] - padTop
  return {
    start,
    end,
    padTop,
    renderedRows,
    padBottom: index.totalRows - index.prefixRows[end],
  }
}
