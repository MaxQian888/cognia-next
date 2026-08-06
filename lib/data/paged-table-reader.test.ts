import { createPagedTableReader } from "./paged-table-reader"

function fakeTable<T>(rows: T[], lifecycle?: { active: number; maxActive: number }) {
  return {
    toCollection: () => ({
      offset: (offset: number) => ({
        limit: (limit: number) => ({
          toArray: async () => {
            if (lifecycle) {
              lifecycle.active += 1
              lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active)
              await new Promise((resolve) => setTimeout(resolve, 1))
              lifecycle.active -= 1
            }
            return rows.slice(offset, offset + limit)
          },
        }),
      }),
    }),
  }
}

describe("createPagedTableReader", () => {
  it("reads the complete table in fixed-size pages", async () => {
    const rows = Array.from({ length: 1_205 }, (_, id) => ({ id }))
    const read = createPagedTableReader({ pageSize: 500, concurrency: 2 })

    await expect(read(fakeTable(rows))).resolves.toEqual(rows)
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
