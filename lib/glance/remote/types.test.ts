import { GLANCE_MAX_PLUGIN_ENTRIES } from "@/types/glance/layout"

import {
  GLANCE_HOST_MODULES,
  glanceRefused,
  isGlanceHostEntry,
  isGlanceHostModule,
  isGlanceRemoteResult,
  isGlanceSubscribeResponse,
  mergeGlanceDemands,
  parseGlanceDemand,
  parseGlanceQuotaEnablePayload,
  parseGlanceRemoteRequestPayload,
  parseGlanceSubscribePayload,
  type GlanceRemoteDemand,
} from "./types"

const DEMAND: GlanceRemoteDemand = {
  modules: ["fleet", "usage"],
  catalog: false,
  scope: "all",
  workspaceId: null,
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "3m" },
}

describe("isGlanceHostModule", () => {
  it.each(GLANCE_HOST_MODULES.map((id) => [id]))("%s is host-sourced", (id) => {
    expect(isGlanceHostModule(id)).toBe(true)
  })

  it.each([["recents"], ["quick"]] as const)("%s is built on the phone", (id) => {
    expect(isGlanceHostModule(id)).toBe(false)
  })
})

describe("glanceRefused", () => {
  it("wraps a code", () => {
    expect(glanceRefused("headless_host")).toEqual({ ok: false, code: "headless_host" })
  })
})

describe("parseGlanceDemand", () => {
  it("accepts a valid demand", () => {
    expect(parseGlanceDemand(DEMAND)).toEqual(DEMAND)
  })

  it("accepts every host module and an empty module list", () => {
    expect(parseGlanceDemand({ ...DEMAND, modules: [...GLANCE_HOST_MODULES] })?.modules).toEqual([
      ...GLANCE_HOST_MODULES,
    ])
    expect(parseGlanceDemand({ ...DEMAND, modules: [] })?.modules).toEqual([])
  })

  it("dedupes modules in first-seen order", () => {
    expect(
      parseGlanceDemand({ ...DEMAND, modules: ["usage", "fleet", "usage", "fleet"] })?.modules
    ).toEqual(["usage", "fleet"])
  })

  it("rejects a list longer than twice the host modules and plugin entries it can hold", () => {
    const limit = (GLANCE_HOST_MODULES.length + GLANCE_MAX_PLUGIN_ENTRIES) * 2
    const modules = Array.from({ length: limit + 1 }, () => "fleet")
    expect(parseGlanceDemand({ ...DEMAND, modules })).toBeNull()
    const atLimit = Array.from({ length: limit }, () => "fleet")
    expect(parseGlanceDemand({ ...DEMAND, modules: atLimit })?.modules).toEqual(["fleet"])
  })

  it("accepts plugin entries, deduplicated, up to the layout's limit", () => {
    expect(
      parseGlanceDemand({
        ...DEMAND,
        modules: ["fleet", "plugin:com.ci:status", "plugin:com.ci:status"],
      })?.modules
    ).toEqual(["fleet", "plugin:com.ci:status"])
    const tooMany = Array.from(
      { length: GLANCE_MAX_PLUGIN_ENTRIES + 1 },
      (_, i) => `plugin:p:m${i}`
    )
    expect(parseGlanceDemand({ ...DEMAND, modules: tooMany })).toBeNull()
    expect(parseGlanceDemand({ ...DEMAND, modules: ["plugin:bad id:x"] })).toBeNull()
  })

  it("reads the catalogue flag, absent meaning false, and refuses a non-boolean", () => {
    expect(parseGlanceDemand({ ...DEMAND, catalog: true })?.catalog).toBe(true)
    const { catalog: _omit, ...older } = DEMAND
    expect(parseGlanceDemand(older)?.catalog).toBe(false)
    expect(parseGlanceDemand({ ...DEMAND, catalog: "yes" })).toBeNull()
  })

  it.each([["recents"], ["quick"], ["bogus"], [3], [null]])(
    "rejects the whole demand for module %j",
    (bad) => {
      expect(parseGlanceDemand({ ...DEMAND, modules: ["fleet", bad] })).toBeNull()
    }
  )

  it("keeps the workspace id with the workspace scope and nulls it with all", () => {
    expect(parseGlanceDemand({ ...DEMAND, scope: "workspace", workspaceId: "p1" })).toMatchObject({
      scope: "workspace",
      workspaceId: "p1",
    })
    expect(parseGlanceDemand({ ...DEMAND, scope: "all", workspaceId: "p1" })).toMatchObject({
      scope: "all",
      workspaceId: null,
    })
    expect(parseGlanceDemand({ ...DEMAND, scope: "workspace", workspaceId: null })).toMatchObject({
      scope: "workspace",
      workspaceId: null,
    })
  })

  it.each([
    ["non-object", null],
    ["array", []],
    ["string", "demand"],
    ["modules not an array", { ...DEMAND, modules: "fleet" }],
    ["missing modules", { ...DEMAND, modules: undefined }],
    ["bad scope", { ...DEMAND, scope: "project" }],
    ["missing scope", { ...DEMAND, scope: undefined }],
    ["missing workspaceId", { ...DEMAND, workspaceId: undefined }],
    ["empty workspaceId", { ...DEMAND, workspaceId: "" }],
    ["long workspaceId", { ...DEMAND, workspaceId: "x".repeat(129) }],
    ["numeric workspaceId", { ...DEMAND, workspaceId: 7 }],
    ["missing usage", { ...DEMAND, usage: undefined }],
    ["array usage", { ...DEMAND, usage: [] }],
    ["missing activity", { ...DEMAND, activity: undefined }],
    ["bad usage scope", { ...DEMAND, usage: { scope: "everything", showSpend: false } }],
    ["string showSpend", { ...DEMAND, usage: { scope: "cognia", showSpend: "true" } }],
    ["missing showSpend", { ...DEMAND, usage: { scope: "cognia" } }],
    ["bad range", { ...DEMAND, activity: { range: "5y" } }],
    ["numeric range", { ...DEMAND, activity: { range: 3 } }],
  ])("rejects %s", (_name, raw) => {
    expect(parseGlanceDemand(raw)).toBeNull()
  })

  it("accepts a workspace id at the length limit", () => {
    const id = "w".repeat(128)
    expect(parseGlanceDemand({ ...DEMAND, scope: "workspace", workspaceId: id })?.workspaceId).toBe(
      id
    )
  })

  it("drops unknown extra fields", () => {
    const out = parseGlanceDemand({
      ...DEMAND,
      extra: 1,
      usage: { ...DEMAND.usage, x: 2 },
      activity: { ...DEMAND.activity, y: 3 },
    })
    expect(out).toEqual(DEMAND)
  })
})

describe("parseGlanceSubscribePayload", () => {
  const valid = { consumer: "phone-1", visible: true, demand: DEMAND }

  it("accepts a valid payload", () => {
    expect(parseGlanceSubscribePayload(valid)).toEqual(valid)
    expect(parseGlanceSubscribePayload({ ...valid, visible: false })?.visible).toBe(false)
  })

  it.each([
    ["non-object", null],
    ["empty consumer", { ...valid, consumer: "" }],
    ["long consumer", { ...valid, consumer: "c".repeat(65) }],
    ["numeric consumer", { ...valid, consumer: 1 }],
    ["string visible", { ...valid, visible: "true" }],
    ["missing visible", { ...valid, visible: undefined }],
    ["bad demand", { ...valid, demand: { ...DEMAND, scope: "x" } }],
    ["missing demand", { ...valid, demand: undefined }],
  ])("rejects %s", (_name, raw) => {
    expect(parseGlanceSubscribePayload(raw)).toBeNull()
  })

  it("accepts a consumer at the length limit and drops extra fields", () => {
    const consumer = "c".repeat(64)
    expect(parseGlanceSubscribePayload({ ...valid, consumer, callerDeviceId: "dev" })).toEqual({
      ...valid,
      consumer,
    })
  })
})

describe("parseGlanceRemoteRequestPayload", () => {
  it("accepts refresh and quota-refresh", () => {
    expect(parseGlanceRemoteRequestPayload({ consumer: "c", kind: "refresh", key: "x" })).toEqual({
      consumer: "c",
      kind: "refresh",
    })
    expect(
      parseGlanceRemoteRequestPayload({ consumer: "c", kind: "quota-refresh", key: "anthropic:a" })
    ).toEqual({ consumer: "c", kind: "quota-refresh", key: "anthropic:a" })
  })

  it("accepts a key at the length limit", () => {
    const key = "k".repeat(300)
    expect(parseGlanceRemoteRequestPayload({ consumer: "c", kind: "quota-refresh", key })).toEqual({
      consumer: "c",
      kind: "quota-refresh",
      key,
    })
  })

  it.each([
    ["non-object", "refresh"],
    ["missing consumer", { kind: "refresh" }],
    ["long consumer", { consumer: "c".repeat(65), kind: "refresh" }],
    ["unknown kind", { consumer: "c", kind: "quota-enable" }],
    ["quota-refresh without key", { consumer: "c", kind: "quota-refresh" }],
    ["quota-refresh empty key", { consumer: "c", kind: "quota-refresh", key: "" }],
    ["quota-refresh long key", { consumer: "c", kind: "quota-refresh", key: "k".repeat(301) }],
    ["quota-refresh numeric key", { consumer: "c", kind: "quota-refresh", key: 1 }],
  ])("rejects %s", (_name, raw) => {
    expect(parseGlanceRemoteRequestPayload(raw)).toBeNull()
  })
})

describe("parseGlanceQuotaEnablePayload", () => {
  it("accepts a provider and account", () => {
    expect(
      parseGlanceQuotaEnablePayload({ provider: "anthropic", accountId: "acc", extra: 1 })
    ).toEqual({ provider: "anthropic", accountId: "acc" })
  })

  it.each([
    ["non-object", null],
    ["missing provider", { accountId: "a" }],
    ["empty provider", { provider: "", accountId: "a" }],
    ["long provider", { provider: "p".repeat(65), accountId: "a" }],
    ["missing account", { provider: "p" }],
    ["long account", { provider: "p", accountId: "a".repeat(129) }],
    ["numeric account", { provider: "p", accountId: 1 }],
  ])("rejects %s", (_name, raw) => {
    expect(parseGlanceQuotaEnablePayload(raw)).toBeNull()
  })
})

describe("isGlanceRemoteResult", () => {
  it("accepts ok and refused results", () => {
    expect(isGlanceRemoteResult({ ok: true })).toBe(true)
    expect(isGlanceRemoteResult({ ok: false, code: "errors.requestFailed" })).toBe(true)
  })

  it.each([
    [null],
    ["ok"],
    [[]],
    [{}],
    [{ ok: false }],
    [{ ok: false, code: 3 }],
    [{ ok: "true" }],
  ])("rejects %j", (value) => {
    expect(isGlanceRemoteResult(value)).toBe(false)
  })
})

describe("isGlanceSubscribeResponse", () => {
  it("accepts ok with a snapshot (even null) and a ttl", () => {
    expect(isGlanceSubscribeResponse({ ok: true, snapshot: null, ttlMs: 60_000 })).toBe(true)
    expect(isGlanceSubscribeResponse({ ok: true, snapshot: {}, ttlMs: 1 })).toBe(true)
  })

  it("accepts a refusal with a code", () => {
    expect(isGlanceSubscribeResponse({ ok: false, code: "glance_unavailable" })).toBe(true)
  })

  it.each([
    [null],
    [[]],
    [{ ok: true, ttlMs: 1 }],
    [{ ok: true, snapshot: null }],
    [{ ok: true, snapshot: null, ttlMs: "60000" }],
    [{ ok: false }],
    [{ ok: false, code: null }],
    [{ snapshot: null, ttlMs: 1 }],
  ])("rejects %j", (value) => {
    expect(isGlanceSubscribeResponse(value)).toBe(false)
  })
})

describe("mergeGlanceDemands", () => {
  it("is null for no demands", () => {
    expect(mergeGlanceDemands([])).toBeNull()
  })

  it("returns a single demand as is", () => {
    expect(mergeGlanceDemands([{ demand: DEMAND, announcedAt: 1 }])).toEqual(DEMAND)
  })

  it("unions modules in first-seen order", () => {
    const merged = mergeGlanceDemands([
      { demand: { ...DEMAND, modules: ["usage", "quota"] }, announcedAt: 1 },
      { demand: { ...DEMAND, modules: ["fleet", "quota", "pet"] }, announcedAt: 2 },
      { demand: { ...DEMAND, modules: ["usage", "agenda"] }, announcedAt: 3 },
    ])
    expect(merged?.modules).toEqual(["usage", "quota", "fleet", "pet", "agenda"])
  })

  it("takes the options of the newest announcement regardless of order", () => {
    const older: GlanceRemoteDemand = {
      ...DEMAND,
      modules: ["activity"],
      usage: { scope: "all-tools", showSpend: true },
      activity: { range: "1y" },
    }
    const newer: GlanceRemoteDemand = {
      ...DEMAND,
      modules: ["fleet"],
      scope: "workspace",
      workspaceId: "p9",
      activity: { range: "1m" },
    }
    const merged = mergeGlanceDemands([
      { demand: newer, announcedAt: 20 },
      { demand: older, announcedAt: 10 },
    ])
    expect(merged).toEqual({ ...newer, modules: ["fleet", "activity"] })
  })

  it("keeps the first of equally new announcements", () => {
    const a: GlanceRemoteDemand = { ...DEMAND, activity: { range: "1m" } }
    const b: GlanceRemoteDemand = { ...DEMAND, activity: { range: "1y" } }
    expect(
      mergeGlanceDemands([
        { demand: a, announcedAt: 5 },
        { demand: b, announcedAt: 5 },
      ])?.activity.range
    ).toBe("1m")
  })

  it("does not mutate its inputs", () => {
    const input = { ...DEMAND, modules: [...DEMAND.modules] }
    mergeGlanceDemands([
      { demand: input, announcedAt: 1 },
      { demand: { ...DEMAND, modules: ["pet"] }, announcedAt: 2 },
    ])
    expect(input.modules).toEqual(["fleet", "usage"])
  })
})

describe("isGlanceHostEntry", () => {
  it("is true for host-sourced modules and plugin entries, false for the phone's own", () => {
    expect(isGlanceHostEntry("fleet")).toBe(true)
    expect(isGlanceHostEntry("plugin:com.ci:status")).toBe(true)
    expect(isGlanceHostEntry("recents")).toBe(false)
    expect(isGlanceHostEntry("quick")).toBe(false)
  })
})

describe("mergeGlanceDemands catalogue", () => {
  it("asks for the catalogue while any phone does", () => {
    const merged = mergeGlanceDemands([
      { demand: { ...DEMAND, catalog: true }, announcedAt: 1 },
      { demand: { ...DEMAND, catalog: false }, announcedAt: 2 },
    ])
    expect(merged?.catalog).toBe(true)
    expect(
      mergeGlanceDemands([{ demand: { ...DEMAND, catalog: false }, announcedAt: 1 }])?.catalog
    ).toBe(false)
  })
})
