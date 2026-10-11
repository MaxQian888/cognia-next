import { GLANCE_MAX_HEIGHT_MAX, GLANCE_MAX_HEIGHT_MIN } from "@/types/glance/layout"

import { GLANCE_PET_COMMANDS, parseGlanceRequest } from "./requests"

const base = { requestId: "req-1", consumer: "tray-panel" }

const valid: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["refresh", { kind: "refresh" }, { kind: "refresh" }],
  ["open-fleet bare", { kind: "open-fleet" }, { kind: "open-fleet" }],
  [
    "open-fleet with row and filter",
    { kind: "open-fleet", rowId: "row-1", filter: "awaiting" },
    { kind: "open-fleet", rowId: "row-1", filter: "awaiting" },
  ],
  [
    "open-fleet filter working",
    { kind: "open-fleet", filter: "working" },
    { kind: "open-fleet", filter: "working" },
  ],
  [
    "open-fleet filter failed",
    { kind: "open-fleet", filter: "failed" },
    { kind: "open-fleet", filter: "failed" },
  ],
  [
    "open-owner",
    { kind: "open-owner", owner: "scheduler", itemId: "app:abc" },
    { kind: "open-owner", owner: "scheduler", itemId: "app:abc" },
  ],
  [
    "open-owner without item",
    { kind: "open-owner", owner: "usage" },
    { kind: "open-owner", owner: "usage" },
  ],
  [
    "open-session",
    { kind: "open-session", sessionId: "s1" },
    { kind: "open-session", sessionId: "s1" },
  ],
  [
    "quota-refresh",
    { kind: "quota-refresh", key: "anthropic:a" },
    { kind: "quota-refresh", key: "anthropic:a" },
  ],
  [
    "quota-enable",
    { kind: "quota-enable", provider: "anthropic", accountId: "a" },
    { kind: "quota-enable", provider: "anthropic", accountId: "a" },
  ],
  ["set-scope all", { kind: "set-scope", scope: "all" }, { kind: "set-scope", scope: "all" }],
  [
    "set-scope workspace",
    { kind: "set-scope", scope: "workspace" },
    { kind: "set-scope", scope: "workspace" },
  ],
  [
    "set-usage-scope cognia",
    { kind: "set-usage-scope", scope: "cognia" },
    { kind: "set-usage-scope", scope: "cognia" },
  ],
  [
    "set-usage-scope all-tools",
    { kind: "set-usage-scope", scope: "all-tools" },
    { kind: "set-usage-scope", scope: "all-tools" },
  ],
  [
    "set-show-spend true",
    { kind: "set-show-spend", showSpend: true },
    { kind: "set-show-spend", showSpend: true },
  ],
  [
    "set-show-spend false",
    { kind: "set-show-spend", showSpend: false },
    { kind: "set-show-spend", showSpend: false },
  ],
  [
    "set-activity-range 1m",
    { kind: "set-activity-range", range: "1m" },
    { kind: "set-activity-range", range: "1m" },
  ],
  [
    "set-activity-range 3m",
    { kind: "set-activity-range", range: "3m" },
    { kind: "set-activity-range", range: "3m" },
  ],
  [
    "set-activity-range 1y",
    { kind: "set-activity-range", range: "1y" },
    { kind: "set-activity-range", range: "1y" },
  ],
  [
    "set-max-height",
    { kind: "set-max-height", maxHeight: 500 },
    { kind: "set-max-height", maxHeight: 500 },
  ],
  [
    "set-max-height rounds",
    { kind: "set-max-height", maxHeight: 500.6 },
    { kind: "set-max-height", maxHeight: 501 },
  ],
  [
    "set-max-height at min",
    { kind: "set-max-height", maxHeight: GLANCE_MAX_HEIGHT_MIN },
    { kind: "set-max-height", maxHeight: GLANCE_MAX_HEIGHT_MIN },
  ],
  [
    "set-max-height at max",
    { kind: "set-max-height", maxHeight: GLANCE_MAX_HEIGHT_MAX },
    { kind: "set-max-height", maxHeight: GLANCE_MAX_HEIGHT_MAX },
  ],
  [
    "set-width narrow",
    { kind: "set-width", width: "narrow" },
    { kind: "set-width", width: "narrow" },
  ],
  [
    "set-width standard",
    { kind: "set-width", width: "standard" },
    { kind: "set-width", width: "standard" },
  ],
  ["set-width wide", { kind: "set-width", width: "wide" }, { kind: "set-width", width: "wide" }],
  ...GLANCE_PET_COMMANDS.map(
    (command): [string, Record<string, unknown>, Record<string, unknown>] => [
      `pet-care ${command}`,
      { kind: "pet-care", command },
      { kind: "pet-care", command },
    ]
  ),
]

describe("parseGlanceRequest", () => {
  it.each(valid)("accepts %s", (_name, body, expected) => {
    expect(parseGlanceRequest({ ...base, ...body })).toEqual({ ...base, ...expected })
  })

  it("accepts every owner surface", () => {
    for (const owner of [
      "fleet",
      "usage",
      "subscription",
      "scheduler",
      "notifications",
      "connectivity",
      "conversations",
      "pet",
      "tray-actions",
    ]) {
      expect(parseGlanceRequest({ ...base, kind: "open-owner", owner })).toMatchObject({ owner })
    }
  })

  it.each([[null], [undefined], ["refresh"], [1], [true]])("rejects non-object %j", (value) => {
    expect(parseGlanceRequest(value)).toBeNull()
  })

  describe("envelope", () => {
    it.each([
      ["missing requestId", { consumer: "c", kind: "refresh" }],
      ["empty requestId", { requestId: "", consumer: "c", kind: "refresh" }],
      ["numeric requestId", { requestId: 1, consumer: "c", kind: "refresh" }],
      ["missing consumer", { requestId: "r", kind: "refresh" }],
      ["empty consumer", { requestId: "r", consumer: "", kind: "refresh" }],
      ["missing kind", { requestId: "r", consumer: "c" }],
      ["numeric kind", { requestId: "r", consumer: "c", kind: 1 }],
      ["unknown kind", { requestId: "r", consumer: "c", kind: "approve-everything" }],
      ["prototype kind", { requestId: "r", consumer: "c", kind: "__proto__" }],
    ])("rejects %s", (_name, value) => {
      expect(parseGlanceRequest(value)).toBeNull()
    })

    it("caps requestId and consumer at 512 characters", () => {
      expect(
        parseGlanceRequest({ requestId: "r".repeat(512), consumer: "c", kind: "refresh" })
      ).not.toBeNull()
      expect(
        parseGlanceRequest({ requestId: "r".repeat(513), consumer: "c", kind: "refresh" })
      ).toBeNull()
      expect(
        parseGlanceRequest({ requestId: "r", consumer: "c".repeat(513), kind: "refresh" })
      ).toBeNull()
    })
  })

  describe("payload validation", () => {
    const reject = (body: Record<string, unknown>) =>
      expect(parseGlanceRequest({ ...base, ...body })).toBeNull()

    it("rejects a bad open-fleet row id or filter", () => {
      reject({ kind: "open-fleet", rowId: "" })
      reject({ kind: "open-fleet", rowId: 3 })
      reject({ kind: "open-fleet", rowId: "r".repeat(513) })
      reject({ kind: "open-fleet", filter: "done" })
      reject({ kind: "open-fleet", filter: null })
    })

    it("rejects a bad owner or item id on open-owner", () => {
      reject({ kind: "open-owner" })
      reject({ kind: "open-owner", owner: "settings" })
      reject({ kind: "open-owner", owner: 1 })
      reject({ kind: "open-owner", owner: "usage", itemId: "" })
      reject({ kind: "open-owner", owner: "usage", itemId: "i".repeat(513) })
      reject({ kind: "open-owner", owner: "usage", itemId: 5 })
    })

    it("rejects over-long or missing ids on the id-carrying kinds", () => {
      reject({ kind: "open-session" })
      reject({ kind: "open-session", sessionId: "s".repeat(513) })
      reject({ kind: "quota-refresh", key: "" })
      reject({ kind: "quota-refresh", key: "k".repeat(513) })
      reject({ kind: "quota-enable", provider: "p" })
      reject({ kind: "quota-enable", accountId: "a" })
      reject({ kind: "quota-enable", provider: "p", accountId: "a".repeat(513) })
    })

    it("rejects invalid enums", () => {
      reject({ kind: "set-scope", scope: "cognia" })
      reject({ kind: "set-usage-scope", scope: "workspace" })
      reject({ kind: "set-activity-range", range: "2y" })
      reject({ kind: "set-width", width: "huge" })
      reject({ kind: "set-width" })
    })

    it("rejects a non-boolean showSpend", () => {
      reject({ kind: "set-show-spend", showSpend: "true" })
      reject({ kind: "set-show-spend", showSpend: 1 })
      reject({ kind: "set-show-spend" })
    })

    it("rejects out-of-range, NaN, infinite and non-number max heights", () => {
      reject({ kind: "set-max-height", maxHeight: GLANCE_MAX_HEIGHT_MIN - 1 })
      reject({ kind: "set-max-height", maxHeight: GLANCE_MAX_HEIGHT_MAX + 1 })
      reject({ kind: "set-max-height", maxHeight: NaN })
      reject({ kind: "set-max-height", maxHeight: Infinity })
      reject({ kind: "set-max-height", maxHeight: "600" })
      reject({ kind: "set-max-height" })
    })

    it("rejects a pet-care command outside GLANCE_PET_COMMANDS", () => {
      reject({ kind: "pet-care", command: "pet.kill" })
      reject({ kind: "pet-care", command: "feed" })
      reject({ kind: "pet-care" })
      reject({ kind: "pet-care", command: "toString" })
    })
  })

  describe("unknown extra keys", () => {
    it.each(valid.map(([name, body]) => [name, body] as const))(
      "%s never carries an unknown key",
      (_name, body) => {
        const out = parseGlanceRequest({ ...base, ...body, evil: 1, extra: "y" })
        expect(out).not.toBeNull()
        expect(out).not.toHaveProperty("evil")
        expect(out).not.toHaveProperty("extra")
      }
    )

    it("omits optional fields that were not sent", () => {
      expect(Object.keys(parseGlanceRequest({ ...base, kind: "open-fleet" })!).sort()).toEqual([
        "consumer",
        "kind",
        "requestId",
      ])
    })
  })
})
