import { buildRecentsSlice, type RecentSessionInput } from "./build-recents"
import { GLANCE_RECENTS_MAX_ROWS } from "./snapshot"

const NOW = 1_800_000_000_000

const s = (
  id: string,
  updatedAt: number,
  extra: Partial<RecentSessionInput> = {}
): RecentSessionInput => ({
  id,
  title: `Title ${id}`,
  updatedAt,
  ...extra,
})

describe("buildRecentsSlice", () => {
  it("returns an empty slice stamped with now", () => {
    expect(buildRecentsSlice([], null, NOW)).toEqual({ updatedAt: NOW, rows: [] })
  })

  it("sorts newest first", () => {
    const out = buildRecentsSlice([s("a", 1), s("b", 3), s("c", 2)], null, NOW)
    expect(out.rows.map((r) => r.id)).toEqual(["b", "c", "a"])
  })

  it("excludes archived sessions (null or undefined archivedAt counts as live)", () => {
    const out = buildRecentsSlice(
      [
        s("a", 1, { archivedAt: 5 }),
        s("b", 2, { archivedAt: null }),
        s("c", 3),
        s("d", 4, { archivedAt: 0 }),
      ],
      null,
      NOW
    )
    expect(out.rows.map((r) => r.id)).toEqual(["c", "b"])
  })

  it("excludes the active session", () => {
    const out = buildRecentsSlice([s("a", 1), s("b", 2)], "b", NOW)
    expect(out.rows.map((r) => r.id)).toEqual(["a"])
  })

  it("caps the list", () => {
    const sessions = Array.from({ length: GLANCE_RECENTS_MAX_ROWS + 3 }, (_, i) => s(`s${i}`, i))
    const out = buildRecentsSlice(sessions, null, NOW)
    expect(out.rows).toHaveLength(GLANCE_RECENTS_MAX_ROWS)
    expect(out.rows[0].id).toBe(`s${GLANCE_RECENTS_MAX_ROWS + 2}`)
  })

  it("applies the cap after filtering", () => {
    const sessions = [
      ...Array.from({ length: 3 }, (_, i) => s(`arch${i}`, 100 + i, { archivedAt: 1 })),
      ...Array.from({ length: GLANCE_RECENTS_MAX_ROWS }, (_, i) => s(`live${i}`, i)),
    ]
    expect(buildRecentsSlice(sessions, null, NOW).rows).toHaveLength(GLANCE_RECENTS_MAX_ROWS)
  })

  it("does not mutate the input array", () => {
    const sessions = [s("a", 1), s("b", 2)]
    buildRecentsSlice(sessions, null, NOW)
    expect(sessions.map((x) => x.id)).toEqual(["a", "b"])
  })

  it("carries id and updatedAt only, with no extra keys", () => {
    const out = buildRecentsSlice([s("a", 7)], null, NOW)
    expect(Object.keys(out.rows[0]).sort()).toEqual(["id", "title", "updatedAt"])
  })

  it("truncates a long title to one capped line", () => {
    const out = buildRecentsSlice(
      [s("a", 1, { title: `line one\nline two ${"x".repeat(200)}` })],
      null,
      NOW
    )
    const title = out.rows[0].title
    expect(title.length).toBeLessThanOrEqual(64)
    expect(title).not.toContain("\n")
    expect(title.endsWith("…")).toBe(true)
  })

  it("redacts secrets and emails from titles", () => {
    const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    const out = buildRecentsSlice(
      [s("a", 2, { title: `use ${key}` }), s("b", 1, { title: "mail me at jane.doe@example.com" })],
      null,
      NOW
    )
    const joined = out.rows.map((r) => r.title).join("|")
    expect(joined).not.toContain(key)
    expect(joined).not.toContain("jane.doe@example.com")
  })
})
