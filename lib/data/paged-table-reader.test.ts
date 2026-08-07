import { createPagedTablePageIterator, createPagedTableReader } from "./paged-table-reader"

function fakeTable<T extends { id: number }>(
  rows: T[],
  lifecycle?: { active: number; maxActive: number },
  observedLowerBounds: Array<number | undefined> = []
) {
  const page = (lowerBound?: number) => ({
    limit: (limit: number) => ({
      each: async (callback: (row: T, cursor: { primaryKey: number }) => void) => {
        observedLowerBounds.push(lowerBound)
        if (lifecycle) {
          lifecycle.active += 1
          lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          lifecycle.active -= 1
        }
        for (const row of rows
          .filter((item) => lowerBound === undefined || item.id > lowerBound)
          .slice(0, limit)) {
          callback(row, { primaryKey: row.id })
        }
      },
    }),
  })
  return {
    orderBy: () => page(),
    where: () => ({ above: (key: number) => page(key) }),
  }
}

describe("createPagedTableReader", () => {
  it("reads the complete table in fixed-size pages", async () => {
    const rows = Array.from({ length: 1_205 }, (_, id) => ({ id }))
    const observedLowerBounds: Array<number | undefined> = []
    const read = createPagedTableReader({ pageSize: 500, concurrency: 2 })

    await expect(read(fakeTable(rows, undefined, observedLowerBounds))).resolves.toEqual(rows)
    expect(observedLowerBounds).toEqual([undefined, 499, 999])
  })

  it("limits page reads shared by concurrently exported tables", async () => {
    const lifecycle = { active: 0, maxActive: 0 }
    const rows = Array.from({ length: 15 }, (_, id) => ({ id }))
    const read = createPagedTableReader({ pageSize: 5, concurrency: 2 })

    await Promise.all([
      read(fakeTable(rows, lifecycle)),
      read(fakeTable(rows, lifecycle)),
      read(fakeTable(rows, lifecycle)),
      read(fakeTable(rows, lifecycle)),
    ])

    expect(lifecycle.maxActive).toBe(2)
  })

  it("rejects invalid page and concurrency limits", () => {
    expect(() => createPagedTableReader({ pageSize: 0, concurrency: 1 })).toThrow(/pageSize/)
    expect(() => createPagedTableReader({ pageSize: 1, concurrency: 0 })).toThrow(/concurrency/)
  })
})

describe("createPagedTablePageIterator", () => {
  it("yields bounded pages without retaining rows from prior pages", async () => {
    const rows = Array.from({ length: 7 }, (_, id) => ({ id }))
    const iterate = createPagedTablePageIterator({ pageSize: 3, concurrency: 1 })
    const pages: Array<Array<{ id: number }>> = []

    for await (const page of iterate(fakeTable(rows))) pages.push(page)

    expect(pages.map((page) => page.map((row) => row.id))).toEqual([[0, 1, 2], [3, 4, 5], [6]])
  })
})
