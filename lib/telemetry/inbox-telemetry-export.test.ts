/**
 * @jest-environment jsdom
 */

import type { InboxTelemetryEventRow } from "@/lib/db/inbox-telemetry-types"
import { toCsv, toJson, buildExportFilename, exportInboxTelemetry } from "./inbox-telemetry-export"

// jsdom doesn't ship URL.createObjectURL / revokeObjectURL — the download
// path needs both, so stub them out for the duration of the export tests.
beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      value: () => "blob:mock",
      writable: true,
    })
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      value: () => undefined,
      writable: true,
    })
  }
})

function row(overrides: Partial<InboxTelemetryEventRow>): InboxTelemetryEventRow {
  return {
    id: overrides.id ?? "te-1",
    kind: overrides.kind ?? "outbound.sent",
    at: overrides.at ?? Date.UTC(2026, 0, 2, 3, 4, 5),
    adapterId: overrides.adapterId,
    conversationKey: overrides.conversationKey,
    fields: overrides.fields,
  }
}

describe("toCsv", () => {
  it("emits header + body lines with ISO timestamps", () => {
    const csv = toCsv([
      row({ kind: "inbound.received", adapterId: "tg-1", conversationKey: "telegram:tg-1:42" }),
    ])
    const [header, body] = csv.split("\n")
    expect(header).toBe("at,kind,adapterId,conversationKey,fields")
    expect(body).toBe("2026-01-02T03:04:05.000Z,inbound.received,tg-1,telegram:tg-1:42,")
  })

  it("escapes commas, quotes, and newlines in field payloads", () => {
    const csv = toCsv([row({ fields: { msg: 'a,b"c\nd' } })])
    const [, body] = csv.split("\n")
    expect(body).toContain('"{""msg"":""a,b\\""c\\nd""}"')
  })

  it("emits empty cells for undefined optional columns", () => {
    const csv = toCsv([row({})])
    const [, body] = csv.split("\n")
    // adapterId / conversationKey / fields are empty.
    expect(body.split(",").slice(2).join(",")).toBe(",,")
  })
})

describe("toJson", () => {
  it("emits pretty-printed JSON array", () => {
    const out = toJson([row({})])
    expect(out.startsWith("[")).toBe(true)
    expect(out.endsWith("]")).toBe(true)
    const parsed = JSON.parse(out)
    expect(parsed).toHaveLength(1)
  })
})

describe("buildExportFilename", () => {
  it("formats UTC stamp + format suffix", () => {
    const name = buildExportFilename({ format: "csv", now: Date.UTC(2026, 4, 22, 6, 7) })
    expect(name).toBe("cognia-inbox-telemetry-202605220607.csv")
  })

  it("changes extension for JSON", () => {
    const name = buildExportFilename({ format: "json", now: Date.UTC(2026, 4, 22, 6, 7) })
    expect(name).toBe("cognia-inbox-telemetry-202605220607.json")
  })
})

describe("exportInboxTelemetry", () => {
  it("returns the resolved filename + mime", () => {
    // jsdom provides URL.createObjectURL via the polyfill in jest setup.
    const out = exportInboxTelemetry({
      rows: [row({})],
      format: "csv",
      now: Date.UTC(2026, 0, 1, 0, 0),
    })
    expect(out.filename).toBe("cognia-inbox-telemetry-202601010000.csv")
    expect(out.mime).toBe("text/csv;charset=utf-8")
  })

  it("uses application/json MIME for json format", () => {
    const out = exportInboxTelemetry({
      rows: [row({})],
      format: "json",
      now: Date.UTC(2026, 0, 1, 0, 0),
    })
    expect(out.mime).toBe("application/json")
  })
})
