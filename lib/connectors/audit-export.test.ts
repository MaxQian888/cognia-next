/**
 * @jest-environment jsdom
 */

import type { ConnectorAuditRow } from "@/lib/db/connector-types"
import { buildExportFilename, downloadBlob, exportAuditView, toCsv, toJson } from "./audit-export"

function row(overrides: Partial<ConnectorAuditRow> = {}): ConnectorAuditRow {
  return {
    id: "aud-1",
    adapterId: "tg-1",
    kind: "delivery.success",
    at: Date.UTC(2026, 0, 15, 9, 5, 0),
    ...overrides,
  } as ConnectorAuditRow
}

describe("toCsv", () => {
  it("emits a header row first", () => {
    const csv = toCsv([])
    expect(csv).toBe("at,adapterId,kind,reason,conversationKey,idempotencyKey,message,fields")
  })

  it("serialises one row with ISO timestamp and empty optionals", () => {
    const csv = toCsv([row()])
    const [header, body] = csv.split("\n")
    expect(header).toContain("at,adapterId,kind")
    expect(body).toContain("2026-01-15T09:05:00.000Z")
    expect(body).toContain("tg-1")
    expect(body).toContain("delivery.success")
  })

  it("escapes commas, quotes, and newlines per RFC-4180", () => {
    const csv = toCsv([
      row({
        message: 'multi, "line"\nvalue',
        reason: "with,comma",
      }),
    ])
    const body = csv.split("\n").slice(1).join("\n")
    expect(body).toContain('"with,comma"')
    expect(body).toContain('"multi, ""line""')
  })

  it("JSON-stringifies the fields payload into a single column", () => {
    const csv = toCsv([row({ fields: { foo: 1, bar: "two" } })])
    const body = csv.split("\n").slice(1).join("\n")
    expect(body).toContain('"{""foo"":1,""bar"":""two""}"')
  })
})

describe("toJson", () => {
  it("returns a pretty-printed array of the rows verbatim", () => {
    const json = toJson([row({ fields: { x: 1 } })])
    const parsed = JSON.parse(json) as ConnectorAuditRow[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].fields).toEqual({ x: 1 })
    // Pretty-printed → at least two newlines (object + opening brace + closing).
    expect(json.split("\n").length).toBeGreaterThan(3)
  })

  it("returns []  for an empty input", () => {
    expect(toJson([])).toBe("[]")
  })
})

describe("buildExportFilename", () => {
  it("uses 'all' when no adapterId is supplied", () => {
    const name = buildExportFilename({
      format: "csv",
      now: Date.UTC(2026, 1, 3, 4, 5, 0),
    })
    expect(name).toBe("cognia-audit-all-202602030405.csv")
  })

  it("uses the adapterId when provided", () => {
    const name = buildExportFilename({
      adapterId: "tg-foo",
      format: "json",
      now: Date.UTC(2026, 11, 31, 23, 59, 0),
    })
    expect(name).toBe("cognia-audit-tg-foo-202612312359.json")
  })

  it("pads single-digit month and minute", () => {
    const name = buildExportFilename({
      format: "csv",
      now: Date.UTC(2026, 2, 5, 7, 3, 0),
    })
    expect(name).toContain("202603050703")
  })
})

describe("downloadBlob (jsdom)", () => {
  // jsdom doesn't ship URL.createObjectURL / revokeObjectURL — define them
  // as writable properties so jest.spyOn works in every Node version.
  const originalCreate = (URL as unknown as { createObjectURL?: typeof URL.createObjectURL })
    .createObjectURL
  const originalRevoke = (URL as unknown as { revokeObjectURL?: typeof URL.revokeObjectURL })
    .revokeObjectURL
  let createSpy: jest.SpyInstance
  let revokeSpy: jest.SpyInstance

  beforeAll(() => {
    Object.defineProperty(URL, "createObjectURL", {
      value: () => "blob:placeholder",
      writable: true,
      configurable: true,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      value: () => undefined,
      writable: true,
      configurable: true,
    })
  })

  afterAll(() => {
    if (originalCreate) {
      ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = originalCreate
    }
    if (originalRevoke) {
      ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = originalRevoke
    }
  })

  beforeEach(() => {
    createSpy = jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock")
    revokeSpy = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
  })

  afterEach(() => {
    createSpy.mockRestore()
    revokeSpy.mockRestore()
  })

  it("creates an anchor with the right href + download, clicks, then revokes the URL", () => {
    const clickSpy = jest.fn()
    const appendSpy = jest.spyOn(document.body, "appendChild").mockImplementation((node) => {
      const anchor = node as HTMLAnchorElement
      anchor.click = clickSpy as unknown as () => void
      return Node.prototype.appendChild.call(document.body, node) as Node
    })
    const removeSpy = jest.spyOn(document.body, "removeChild")

    downloadBlob("foo.csv", new Blob(["x"], { type: "text/csv" }))

    expect(createSpy).toHaveBeenCalled()
    expect(appendSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalled()
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock")
  })
})

describe("exportAuditView (integration)", () => {
  // Same URL polyfill as downloadBlob — duplicated here so this describe
  // block can be run in isolation (`pnpm test -- -t "exportAuditView"`).
  beforeAll(() => {
    Object.defineProperty(URL, "createObjectURL", {
      value: () => "blob:placeholder",
      writable: true,
      configurable: true,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      value: () => undefined,
      writable: true,
      configurable: true,
    })
  })

  let createSpy: jest.SpyInstance
  let revokeSpy: jest.SpyInstance
  let clickSpy: jest.Mock

  let appendSpy: jest.SpyInstance

  beforeEach(() => {
    createSpy = jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock")
    revokeSpy = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    clickSpy = jest.fn()
    // Stub `click()` via appendChild so we don't have to spy on
    // createElement (which jsdom proxies through internal slots that
    // recurse when patched).
    appendSpy = jest.spyOn(document.body, "appendChild").mockImplementation((node) => {
      const anchor = node as HTMLAnchorElement
      anchor.click = clickSpy as unknown as () => void
      // Still actually append so removeChild later doesn't throw.
      return Node.prototype.appendChild.call(document.body, node) as Node
    })
  })

  afterEach(() => {
    appendSpy.mockRestore()
    createSpy.mockRestore()
    revokeSpy.mockRestore()
  })

  it("returns filename + mime for CSV", () => {
    const result = exportAuditView({
      rows: [row()],
      format: "csv",
      adapterId: "tg-1",
      now: Date.UTC(2026, 0, 1, 0, 0, 0),
    })
    expect(result.filename).toBe("cognia-audit-tg-1-202601010000.csv")
    expect(result.mime).toBe("text/csv;charset=utf-8")
    expect(clickSpy).toHaveBeenCalled()
  })

  it("returns filename + mime for JSON", () => {
    const result = exportAuditView({
      rows: [],
      format: "json",
      now: Date.UTC(2026, 5, 30, 12, 0, 0),
    })
    expect(result.filename).toBe("cognia-audit-all-202606301200.json")
    expect(result.mime).toBe("application/json")
  })
})
