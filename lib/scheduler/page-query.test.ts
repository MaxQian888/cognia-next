import {
  hasLegacySchedulerParams,
  parseSchedulerQuery,
  resolveLegacySelection,
  schedulerHref,
  schedulerItemHref,
  writeSchedulerQuery,
} from "./page-query"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(kind: UnifiedScheduledItem["kind"], sourceId: string): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name: sourceId,
    status: "active",
    triggerSummary: { type: "cron", cron: "* * * * *" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

describe("parseSchedulerQuery", () => {
  it("reads item and run when they are unified ids", () => {
    const q = parseSchedulerQuery(new URLSearchParams("item=app:a1&run=workflow:r9"))
    expect(q).toEqual({ item: "app:a1", run: "workflow:r9" })
  })

  it("drops a malformed item rather than guessing", () => {
    expect(parseSchedulerQuery(new URLSearchParams("item=nocolon"))).toEqual({})
    expect(parseSchedulerQuery(new URLSearchParams("item=nope:x"))).toEqual({})
    expect(parseSchedulerQuery(new URLSearchParams("run=app:"))).toEqual({})
  })

  it("keeps the three legacy spellings as unresolved ids", () => {
    expect(parseSchedulerQuery(new URLSearchParams("taskId=t1"))).toEqual({ legacyTaskId: "t1" })
    expect(parseSchedulerQuery(new URLSearchParams("task=t2"))).toEqual({ legacyTaskId: "t2" })
    expect(parseSchedulerQuery(new URLSearchParams("systemTaskId=s1"))).toEqual({
      legacySystemTaskId: "s1",
    })
    expect(parseSchedulerQuery(new URLSearchParams("taskId=t1&task=t2")).legacyTaskId).toBe("t1")
  })
})

describe("hasLegacySchedulerParams", () => {
  it("is true only for the legacy names", () => {
    expect(hasLegacySchedulerParams(new URLSearchParams("item=app:a"))).toBe(false)
    expect(hasLegacySchedulerParams(new URLSearchParams("task=a"))).toBe(true)
    expect(hasLegacySchedulerParams(new URLSearchParams("systemTaskId=a"))).toBe(true)
  })
})

describe("resolveLegacySelection", () => {
  const items = [
    item("app", "t1"),
    item("connector", "t2"),
    item("system", "s1"),
    item("workflow", "t1"),
  ]

  it("resolves an app-table id to the app-table row of that id, never a workflow", () => {
    expect(resolveLegacySelection({ legacyTaskId: "t1" }, items)).toBe("app:t1")
    expect(resolveLegacySelection({ legacyTaskId: "t2" }, items)).toBe("connector:t2")
  })

  it("resolves a system id only against system rows", () => {
    expect(resolveLegacySelection({ legacySystemTaskId: "s1" }, items)).toBe("system:s1")
    expect(resolveLegacySelection({ legacySystemTaskId: "t1" }, items)).toBeUndefined()
  })

  it("answers nothing for an unknown id", () => {
    expect(resolveLegacySelection({ legacyTaskId: "ghost" }, items)).toBeUndefined()
    expect(resolveLegacySelection({}, items)).toBeUndefined()
  })
})

describe("writeSchedulerQuery", () => {
  it("sets, clears, and leaves parameters alone", () => {
    const base = new URLSearchParams("item=app:a&run=app:r&other=1")
    expect(writeSchedulerQuery(base, { run: null })).toBe("item=app%3Aa&other=1")
    expect(writeSchedulerQuery(base, { item: "system:s" })).toBe(
      "item=system%3As&run=app%3Ar&other=1"
    )
    expect(writeSchedulerQuery(base, {})).toBe("item=app%3Aa&run=app%3Ar&other=1")
  })

  it("always strips the legacy spellings", () => {
    const base = new URLSearchParams("taskId=t&task=u&systemTaskId=s")
    expect(writeSchedulerQuery(base, { item: "app:t" })).toBe("item=app%3At")
    expect(writeSchedulerQuery(base, {})).toBe("")
  })
})

describe("schedulerHref", () => {
  it("omits the question mark when the query is empty", () => {
    expect(schedulerHref("/scheduler", "")).toBe("/scheduler")
    expect(schedulerHref("/me/scheduler", "item=app%3Aa")).toBe("/me/scheduler?item=app%3Aa")
  })
})

describe("schedulerItemHref", () => {
  it("builds the address parseSchedulerQuery reads back", () => {
    const href = schedulerItemHref({ kind: "app", sourceId: "t1" })
    expect(href).toBe("/scheduler?item=app%3At1")
    const query = parseSchedulerQuery(new URLSearchParams(href.split("?")[1]))
    expect(query.item).toBe("app:t1")
  })

  it("names the run under the item's own kind", () => {
    const href = schedulerItemHref({ kind: "plugin", sourceId: "t2" }, "run-7")
    const query = parseSchedulerQuery(new URLSearchParams(href.split("?")[1]))
    expect(query).toMatchObject({ item: "plugin:t2", run: "plugin:run-7" })
  })

  it("can target the phone route", () => {
    expect(schedulerItemHref({ kind: "app", sourceId: "t1" }, undefined, "/me/scheduler")).toMatch(
      /^\/me\/scheduler\?item=/
    )
  })
})
