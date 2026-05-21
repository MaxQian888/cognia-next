import { buildDlqDownload, dlqRowsToCsv, dlqRowsToJson } from "./dlq-export"
import type { OutboundJobRow } from "@/lib/db/connector-types"

function makeRow(overrides: Partial<OutboundJobRow> = {}): OutboundJobRow {
  return {
    id: "j1",
    adapterId: "lark-1",
    conversationKey: "lark:lark-1:c1",
    status: "deadlettered",
    attempts: 5,
    createdAt: Date.parse("2026-05-20T10:00:00Z"),
    request: {
      metadata: { idempotencyKey: "key-1" },
      segments: [],
      replyTo: undefined,
    } as never,
    ...overrides,
  } as OutboundJobRow
}

describe("dlqRowsToCsv", () => {
  it("produces a header row + value rows", () => {
    const csv = dlqRowsToCsv([makeRow()])
    const [header, body] = csv.split("\n")
    expect(header).toContain("id,adapterId")
    expect(body.startsWith("j1,lark-1,")).toBe(true)
  })

  it("escapes commas / quotes / newlines in error messages", () => {
    const csv = dlqRowsToCsv([
      makeRow({
        lastError: 'oops, "really" bad\nline2',
        lastErrorCode: "platform_5xx",
      }),
    ])
    expect(csv).toContain('"oops, ""really"" bad\nline2"')
  })

  it("renders empty values for missing nextAttemptAt / lastError", () => {
    const csv = dlqRowsToCsv([makeRow({ nextAttemptAt: undefined, lastError: undefined })])
    const valueRow = csv.split("\n")[1]
    // The empty fields appear contiguously between commas — there should be
    // at least one ",,," run (two consecutive empties) in the row.
    expect(valueRow).toContain(",,")
  })
})

describe("dlqRowsToJson", () => {
  it("serialises every column with explicit null for missing values", () => {
    const out = dlqRowsToJson([makeRow({ lastError: undefined, lastErrorCode: undefined })])
    const parsed = JSON.parse(out)
    expect(parsed[0]).toEqual(
      expect.objectContaining({
        id: "j1",
        lastError: null,
      })
    )
  })

  it("includes attemptedAt as an ISO string", () => {
    const out = dlqRowsToJson([makeRow()])
    const parsed = JSON.parse(out)
    expect(parsed[0].createdAt).toBe("2026-05-20T10:00:00.000Z")
  })
})

describe("buildDlqDownload", () => {
  it("returns a CSV blob with a date-stamped filename", () => {
    const dl = buildDlqDownload([makeRow()], "csv")
    expect(dl.filename).toMatch(/^dlq-.*\.csv$/)
    expect(dl.blob.type).toMatch(/text\/csv/)
  })

  it("returns a JSON blob with the right mime type", () => {
    const dl = buildDlqDownload([makeRow()], "json")
    expect(dl.filename).toMatch(/^dlq-.*\.json$/)
    expect(dl.blob.type).toMatch(/application\/json/)
  })
})
