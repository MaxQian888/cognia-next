/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const liveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => liveQueryMock(fn) as T | undefined,
}))

const listSkillsMock = jest.fn(async () => [])
const inferCategoryMock = jest.fn((row: { category?: string }) => row.category ?? "general")
const inferSourceMock = jest.fn((row: { source?: string }) => row.source ?? "local")
jest.mock("@/lib/db/skills", () => ({
  listSkills: () => listSkillsMock(),
  inferCategory: (row: { category?: string }) => inferCategoryMock(row),
  inferSource: (row: { source?: string }) => inferSourceMock(row),
}))

const filtersRef = {
  query: "",
  category: "all" as string,
  source: "all" as string,
  status: "all" as string,
  tag: "" as string,
  sort: "name" as "name" | "updated" | "usage",
}

jest.mock("@/stores/skills", () => ({
  useSkillsStore: <T>(selector: (s: { filters: typeof filtersRef }) => T): T =>
    selector({ filters: filtersRef }),
}))

import { useSkills } from "./use-skills"

beforeEach(() => {
  liveQueryMock.mockReset()
  listSkillsMock.mockClear()
  inferCategoryMock.mockClear()
  inferSourceMock.mockClear()
  filtersRef.query = ""
  filtersRef.category = "all"
  filtersRef.source = "all"
  filtersRef.status = "all"
  filtersRef.tag = ""
  filtersRef.sort = "name"
})

interface FakeSkill {
  id: string
  name: string
  description?: string
  status?: string
  tags?: string[]
  content?: string
  category?: string
  source?: string
  updatedAt?: number
  usageCount?: number
}

function makeRows(): FakeSkill[] {
  return [
    {
      id: "1",
      name: "Alpha",
      description: "first",
      status: "enabled",
      tags: ["x", "y"],
      content: "hello",
      category: "writing",
      source: "local",
      updatedAt: 100,
      usageCount: 10,
    },
    {
      id: "2",
      name: "Beta",
      description: "second",
      status: "disabled",
      tags: ["z"],
      content: "world",
      category: "code",
      source: "marketplace",
      updatedAt: 200,
      usageCount: 5,
    },
    {
      id: "3",
      name: "Gamma",
      tags: [],
      category: "writing",
      source: "local",
      updatedAt: 50,
      usageCount: 0,
    },
  ]
}

describe("useSkills", () => {
  it("falls back to empty arrays when rows are undefined", () => {
    // Note: the hook coerces `undefined` to `null` via `rows ?? null`
    // before the buildView() call, so its `loading: rows === undefined`
    // check resolves to `false`; we exercise the empty-state shape here.
    liveQueryMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useSkills())
    expect(result.current.all).toEqual([])
    expect(result.current.filtered).toEqual([])
    expect(result.current.allTags).toEqual([])
  })

  it("aggregates counts and tags across all rows", () => {
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.countsBySource).toEqual({ local: 2, marketplace: 1 })
    expect(result.current.countsByCategory).toEqual({ writing: 2, code: 1 })
    expect(result.current.allTags).toEqual(["x", "y", "z"])
  })

  it("default sort is by name", () => {
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"])
  })

  it("sort=updated returns newest first", () => {
    filtersRef.sort = "updated"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.id)).toEqual(["2", "1", "3"])
  })

  it("sort=usage returns most-used first", () => {
    filtersRef.sort = "usage"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.id)).toEqual(["1", "2", "3"])
  })

  it("filters by category", () => {
    filtersRef.category = "writing"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.id)).toEqual(["1", "3"])
  })

  it("filters by source", () => {
    filtersRef.source = "marketplace"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.id)).toEqual(["2"])
  })

  it("filters by status using default 'enabled'", () => {
    filtersRef.status = "enabled"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    // Row 1 has status enabled; row 3 has no status field — defaults to enabled.
    expect(result.current.filtered.map((r) => r.id).sort()).toEqual(["1", "3"])
  })

  it("filters by tag", () => {
    filtersRef.tag = "y"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.id)).toEqual(["1"])
  })

  it("filters by query against name / description / tags / content", () => {
    filtersRef.query = "hello"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered.map((r) => r.id)).toEqual(["1"])
    filtersRef.query = "world"
    const { result: r2 } = renderHook(() => useSkills())
    expect(r2.current.filtered.map((r) => r.id)).toEqual(["2"])
    filtersRef.query = "second" // matches description
    const { result: r3 } = renderHook(() => useSkills())
    expect(r3.current.filtered.map((r) => r.id)).toEqual(["2"])
    filtersRef.query = "z" // matches tag
    const { result: r4 } = renderHook(() => useSkills())
    expect(r4.current.filtered.map((r) => r.id)).toEqual(["2"])
  })

  it("non-matching query returns nothing", () => {
    filtersRef.query = "definitely-not-present"
    liveQueryMock.mockReturnValue(makeRows())
    const { result } = renderHook(() => useSkills())
    expect(result.current.filtered).toEqual([])
  })
})
