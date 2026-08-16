import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, makeTestContext } from "../testing"
import { createListProvider } from "./list-provider"
import type { GlobalSearchContext } from "../types"

interface Row {
  id: string
  name: string
  desc?: string
  at: number
  hidden?: boolean
}

const rows: Row[] = [
  { id: "1", name: "Deploy", at: 3 },
  { id: "2", name: "Notes", desc: "deploy checklist", at: 2 },
  { id: "3", name: "Hidden deploy", at: 1, hidden: true },
]

const spec = (
  load: (ctx: GlobalSearchContext) => Promise<readonly Row[]> = jest.fn(async () => rows),
  over: Partial<Parameters<typeof createListProvider<Row>>[0]> = {}
) =>
  createListProvider<Row>({
    id: "test.rows",
    kind: "skill",
    load,
    getTitle: (r) => r.name,
    getSecondary: (r) => r.desc,
    getTimestamp: (r) => r.at,
    include: (r) => !r.hidden,
    toItem: ({ row, match }) => ({
      id: `skill:${row.id}`,
      kind: "skill",
      title: row.name,
      titlePositions: match.positions,
      score: match.score,
      action: { type: "navigate", href: `/skills#${row.id}` },
    }),
    ...over,
  })

describe("createListProvider", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("loads once per cache window, filters hidden rows, ranks and projects", async () => {
    const load = jest.fn(async () => rows)
    const provider = spec(load)
    const out = await provider.search(makeProviderInput("deploy"))
    expect(out.items.map((i) => i.id)).toEqual(["skill:1", "skill:2"])
    expect(out.total).toBe(2)
    expect(out.truncated).toBe(false)
    await provider.search(makeProviderInput("notes"))
    expect(load).toHaveBeenCalledTimes(1)
    expect(provider.cache).not.toBeNull()
    provider.cache!.clear()
    await provider.search(makeProviderInput("notes"))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("bypasses the cache when disabled and passes ctx to load", async () => {
    const load = jest.fn(async (ctx) => (ctx.locale === "zh-CN" ? rows.slice(0, 1) : rows))
    const provider = spec(load, { cache: false })
    expect(provider.cache).toBeNull()
    await provider.search(
      makeProviderInput("deploy", { ctx: makeTestContext({ locale: "zh-CN" }) })
    )
    await provider.search(makeProviderInput("deploy"))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("returns nothing once aborted and exposes suggest only when specified", async () => {
    const controller = new AbortController()
    const provider = spec(
      jest.fn(async () => {
        controller.abort()
        return rows
      })
    )
    expect(
      await provider.search(makeProviderInput("deploy", { signal: controller.signal }))
    ).toEqual({
      items: [],
    })
    expect(provider.suggest).toBeUndefined()
    const suggesting = spec(
      jest.fn(async () => rows),
      {
        id: "test.suggest",
        suggest: (all, _ctx, limit) =>
          all.slice(0, limit).map((r) => ({
            id: `skill:${r.id}`,
            kind: "skill" as const,
            title: r.name,
            score: 1,
            action: { type: "navigate" as const, href: "/" },
          })),
      }
    )
    const items = await suggesting.suggest!({
      ctx: makeTestContext(),
      limit: 1,
      signal: new AbortController().signal,
    })
    expect(items.map((i) => i.id)).toEqual(["skill:1"])
  })

  it("respects the limit and truncation", async () => {
    const provider = spec()
    const out = await provider.search(makeProviderInput("deploy", { limit: 1 }))
    expect(out.items).toHaveLength(1)
    expect(out.truncated).toBe(true)
    expect(out.total).toBe(2)
  })
})
