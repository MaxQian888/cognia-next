import { describe, expect, it } from "vitest"

import { UsageError } from "./args"
import { COMMANDS, buildCommand, parseProfile } from "./commands"

const ctx = { newOperationId: () => "op-fixed-0001" }

function write(argv: string[]) {
  const { operation } = buildCommand(argv, ctx)
  if (operation.kind !== "write") throw new Error("expected a write")
  return operation
}

describe("command table", () => {
  it("covers every documented command", () => {
    expect(COMMANDS).toEqual([
      "delivery inspect",
      "delivery retry",
      "incident create",
      "incident list",
      "incident resolve",
      "incident show",
      "incident update",
      "maintenance cancel",
      "maintenance complete",
      "maintenance extend",
      "maintenance list",
      "maintenance reschedule",
      "maintenance schedule",
      "probe disable",
      "probe enable",
      "probe enroll",
      "probe list",
      "probe set-reference",
    ])
  })

  it("builds a bilingual incident create with a generated operation ID", () => {
    const operation = write([
      "incident",
      "create",
      "--title-en",
      "Relay degraded",
      "--title-zh",
      "中继降级",
      "--message-en",
      "Investigating",
      "--impact",
      "partial_outage",
      "--components",
      "relayData,signalingAuth",
    ])
    expect(operation.path).toBe("/admin/incidents")
    expect(operation.body).toEqual({
      operationId: "op-fixed-0001",
      title: { en: "Relay degraded", "zh-CN": "中继降级" },
      message: { en: "Investigating" },
      impact: "partial_outage",
      componentIds: ["relayData", "signalingAuth"],
      state: "investigating",
    })
  })

  it("requires an explicit revision for updates and maps pin / correction", () => {
    expect(() => buildCommand(["incident", "update", "inc_1", "--message-en", "x"], ctx)).toThrow(
      "--revision is required"
    )
    const operation = write([
      "incident",
      "update",
      "inc_1",
      "--revision",
      "4",
      "--message-en",
      "Fixed wording",
      "--correction-of",
      "upd_1",
      "--pin",
      "--operation-id",
      "op-retry-1234",
    ])
    expect(operation.path).toBe("/admin/incidents/inc_1/updates")
    expect(operation.body).toEqual({
      operationId: "op-retry-1234",
      expectedRevision: 4,
      message: { en: "Fixed wording" },
      pin: true,
      correctionOf: "upd_1",
    })
    expect(operation.summary).toContain("correct update upd_1")
  })

  it("validates with the contract parsers before anything is sent", () => {
    expect(() =>
      buildCommand(
        [
          "incident",
          "create",
          "--title-en",
          "x",
          "--message-en",
          "y",
          "--impact",
          "huge",
          "--components",
          "relayData",
        ],
        ctx
      )
    ).toThrow(/invalid request: .*impact/)
    expect(() =>
      buildCommand(
        [
          "incident",
          "create",
          "--title-en",
          "x",
          "--message-en",
          "y",
          "--impact",
          "degraded",
          "--components",
          "dns",
        ],
        ctx
      )
    ).toThrow(UsageError)
    expect(() => buildCommand(["incident", "create", "--title-zh", "仅中文"], ctx)).toThrow(
      "needs --title-en"
    )
  })

  it("requires the maintenance exclusion choice and minute-aligned UTC times", () => {
    const base = [
      "maintenance",
      "schedule",
      "--title-en",
      "Upgrade",
      "--description-en",
      "Rolling restart",
      "--components",
      "relayData",
      "--starts-at",
      "2026-10-03T01:00:00Z",
      "--ends-at",
      "2026-10-03T02:00:00Z",
    ]
    expect(() => buildCommand(base, ctx)).toThrow("--exclude or --no-exclude")
    const operation = write([...base, "--exclude"])
    expect(operation.body).toMatchObject({
      startsAt: "2026-10-03T01:00:00.000Z",
      excludeFromAvailability: true,
    })
    expect(() =>
      buildCommand([...base.slice(0, -1), "2026-10-03T02:00:30Z", "--no-exclude"], ctx)
    ).toThrow("minute-aligned")
  })

  it("builds maintenance lifecycle changes", () => {
    expect(
      write([
        "maintenance",
        "extend",
        "mnt_1",
        "--revision",
        "2",
        "--ends-at",
        "2026-10-03T03:00:00Z",
      ]).body
    ).toEqual({
      operationId: "op-fixed-0001",
      expectedRevision: 2,
      endsAt: "2026-10-03T03:00:00.000Z",
    })
    expect(
      write(["maintenance", "complete", "mnt_1", "--revision", "3", "--message-en", "Done"]).path
    ).toBe("/admin/maintenance/mnt_1/complete")
    expect(() =>
      buildCommand(
        [
          "maintenance",
          "reschedule",
          "mnt_1",
          "--revision",
          "1",
          "--ends-at",
          "2026-10-03T03:00:00Z",
        ],
        ctx
      )
    ).toThrow("--starts-at is required")
    expect(() =>
      buildCommand(["maintenance", "cancel", "mnt_1", "--revision", "1", "--ends-at", "x"], ctx)
    ).toThrow("unknown option")
  })

  it("builds probe and delivery operations", () => {
    const enroll = write([
      "probe",
      "enroll",
      "--probe-id",
      "ext-hk-1",
      "--label-en",
      "Hong Kong",
      "--enrolled-at",
      "2026-10-03T00:00:00Z",
      "--profile",
      "native:60:60",
      "--profile",
      "web:-:300",
      "--key-id",
      "ext-hk-1-k1",
    ])
    expect(enroll.body).toMatchObject({
      source: "external",
      location: null,
      provider: null,
      profiles: [
        { id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 60 },
        { id: "web", httpCadenceSeconds: null, protocolCadenceSeconds: 300 },
      ],
    })
    expect(write(["probe", "enable", "ext-hk-1", "--reason", "back"]).body).toMatchObject({
      disabled: false,
    })
    expect(write(["delivery", "retry", "out_1", "--acknowledge-uncertain"]).body).toMatchObject({
      acknowledgeUncertain: true,
    })
    const inspect = buildCommand(
      ["delivery", "inspect", "--state", "uncertain", "--limit", "5"],
      ctx
    ).operation
    expect(inspect).toEqual({
      kind: "read",
      method: "GET",
      path: "/admin/delivery?state=uncertain&limit=5",
      view: "deliveries",
    })
    expect(() => parseProfile("desktop:60:60")).toThrow(UsageError)
    expect(() => parseProfile("native:sixty:60")).toThrow(UsageError)
  })

  it("rejects unknown commands and stray arguments", () => {
    expect(() => buildCommand(["incident", "delete"], ctx)).toThrow("unknown command")
    expect(() => buildCommand(["constructor", "name"], ctx)).toThrow("unknown command")
    expect(() => buildCommand(["incident", "show", "inc_1", "extra"], ctx)).toThrow(
      "unexpected argument"
    )
    expect(() => buildCommand(["incident", "show", "../etc"], ctx)).toThrow("invalid incident-id")
  })
})
