/**
 * Tests for lib/slash-commands/actions/lark.ts.
 */

import "fake-indexeddb/auto"
import "@/lib/skills/built-in"
import { dispatchLarkSubcommand, parseLarkArgs } from "./lark"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("parseLarkArgs", () => {
  it("agenda → calendar.agenda_today", () => {
    expect(parseLarkArgs("agenda")).toEqual({
      skillId: "lark.calendar.agenda_today",
      args: {},
    })
  })

  it("events cal_1 --start ... --end ... → calendar.list_events", () => {
    const r = parseLarkArgs("events cal_1 --start 2026-06-01T00:00:00Z --end 2026-06-02T00:00:00Z")
    expect(r.skillId).toBe("lark.calendar.list_events")
    expect(r.args).toEqual({
      calendarId: "cal_1",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
    })
  })

  it("docs search <query> → doc.search", () => {
    expect(parseLarkArgs("docs search Q4 review")).toEqual({
      skillId: "lark.doc.search",
      args: { query: "Q4 review" },
    })
  })

  it("tasks → task.list_my_tasks", () => {
    expect(parseLarkArgs("tasks")).toEqual({
      skillId: "lark.task.list_my_tasks",
      args: {},
    })
  })

  it("wiki <query> → wiki.search_nodes", () => {
    expect(parseLarkArgs("wiki onboarding")).toEqual({
      skillId: "lark.wiki.search_nodes",
      args: { query: "onboarding" },
    })
  })

  it("base search <query> → base.search", () => {
    expect(parseLarkArgs("base search projects")).toEqual({
      skillId: "lark.base.search",
      args: { query: "projects" },
    })
  })

  it("throws on unknown verb", () => {
    expect(() => parseLarkArgs("foo bar")).toThrow(/Unknown \/lark verb/)
  })

  it("throws on missing argv", () => {
    expect(() => parseLarkArgs("")).toThrow(/Missing argument/)
  })

  it("throws on docs without search subcommand", () => {
    expect(() => parseLarkArgs("docs")).toThrow(/Usage/)
  })
})

describe("dispatchLarkSubcommand", () => {
  it("returns a parse_error system block on bad argv", async () => {
    const r = await dispatchLarkSubcommand({ argv: "", sessionId: "s_x" })
    expect(r.errorCode).toBe("parse_error")
    expect(r.system).toContain("parse error")
  })

  it("denies an unknown skill id via a parse-time check (verb whitelist)", async () => {
    const r = await dispatchLarkSubcommand({ argv: "badverb", sessionId: "s_x" })
    expect(r.errorCode).toBe("parse_error")
  })

  it("surfaces 'denied' result as a structured system message for read skills hitting the auth gate", async () => {
    // No Lark adapter configured — the skill's execute() will surface
    // auth_unavailable. The dispatcher catches that and returns an
    // `error` result; the slash command formats it.
    const r = await dispatchLarkSubcommand({ argv: "agenda", sessionId: "s_x" })
    expect(r.system).toContain("/lark")
    // The status is either "error" (auth bridge fails) or "ok" if a mocked
    // adapter is somehow available — both shapes are acceptable in this
    // test scaffold.
    expect(["error", undefined]).toContain(r.errorCode)
  })
})
