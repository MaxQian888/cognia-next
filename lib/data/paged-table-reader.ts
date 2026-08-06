interface CursorPage<T, TKey> {
  limit(limit: number): {
    each(callback: (row: T, cursor: { primaryKey: TKey }) => void): Promise<void>
  }
}

export interface PagedReadable<T, TKey = unknown> {
  orderBy(index: string): CursorPage<T, TKey>
  where(index: string): {
    above(key: TKey): CursorPage<T, TKey>
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

  return async function readTablePaged<T, TKey>(table: PagedReadable<T, TKey>): Promise<T[]> {
    const rows: T[] = []
    let lastPrimaryKey: TKey | undefined
    for (;;) {
      const page: T[] = []
      await withPermit(async () => {
        const collection =
          lastPrimaryKey === undefined
            ? table.orderBy(":id")
            : table.where(":id").above(lastPrimaryKey)
        await collection.limit(pageSize).each((row, cursor) => {
          page.push(row)
          lastPrimaryKey = cursor.primaryKey
        })
      })
      rows.push(...page)
      if (page.length < pageSize) return rows
    }
  }
}
