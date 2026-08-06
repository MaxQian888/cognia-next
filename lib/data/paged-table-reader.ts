export interface PagedReadable<T> {
  toCollection(): {
    offset(offset: number): {
      limit(limit: number): { toArray(): Promise<T[]> }
    }
  }
}

export interface PagedTableReaderOptions {
  pageSize?: number
  concurrency?: number
}

/**
 * Build a reader whose concurrency budget is shared across every table read
 * started through it. The returned arrays are required by BackupPayloadV3,
 * but transient IndexedDB result pages stay bounded instead of materializing
 * dozens of complete tables concurrently.
 */
export function createPagedTableReader(options: PagedTableReaderOptions = {}) {
  const pageSize = Math.floor(options.pageSize ?? 500)
  const concurrency = Math.floor(options.concurrency ?? 4)
  if (pageSize <= 0) throw new RangeError("pageSize must be greater than zero")
  if (concurrency <= 0) throw new RangeError("concurrency must be greater than zero")

  let active = 0
  const waiters: Array<() => void> = []

  async function withPermit<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    active += 1
    try {
      return await operation()
    } finally {
      active -= 1
      waiters.shift()?.()
    }
  }

  return async function readTablePaged<T>(table: PagedReadable<T>): Promise<T[]> {
    const rows: T[] = []
    let offset = 0
    for (;;) {
      const page = await withPermit(() =>
        table.toCollection().offset(offset).limit(pageSize).toArray()
      )
      rows.push(...page)
      if (page.length < pageSize) return rows
      offset += page.length
    }
  }
}
