import {
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  SUPPORTED_SCHEMA_VERSION,
  captureModeFor,
  isCompatible,
  panelStateForError,
  pollIntervalFor,
  type CapturedPage,
} from "./panel-state"
import type { PairingRecord } from "./client"

const PAIRING: PairingRecord = {
  baseUrl: "http://127.0.0.1:27891",
  tenantId: "tenant-a",
  deviceId: "browser-a",
  extensionOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  pairedAt: 1,
}

function page(overrides: Partial<CapturedPage> = {}): CapturedPage {
  return {
    tabId: 1,
    title: "A",
    url: "https://example.com/a",
    rawUrl: "https://example.com/a?x=1",
    selection: null,
    readableText: null,
    capturedAt: 1,
    strippedQuery: true,
    ...overrides,
  }
}

describe("panelStateForError", () => {
  it("treats a revoked device and a wrong origin as terminal", () => {
    // Both mean the Host will not talk to this browser again; only re-pairing
    // fixes either, so a retry button would be a lie.
    for (const code of ["device_unavailable", "device_origin_mismatch"]) {
      expect(panelStateForError({ code }, PAIRING)).toEqual({ kind: "revoked" })
    }
  })

  it("treats everything else as the Host being unreachable", () => {
    // A network blip must not throw away a working pairing.
    expect(panelStateForError(new Error("fetch failed"), PAIRING)).toEqual({
      kind: "host-offline",
      pairing: PAIRING,
    })
    expect(panelStateForError({ code: "rate_limited" }, PAIRING)).toMatchObject({
      kind: "host-offline",
    })
  })
})

describe("isCompatible", () => {
  it("accepts only the schema version this build implements", () => {
    expect(isCompatible({ schemaVersion: SUPPORTED_SCHEMA_VERSION })).toBe(true)
    expect(isCompatible({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 })).toBe(false)
    expect(isCompatible({ schemaVersion: 0 })).toBe(false)
  })
})

describe("captureModeFor", () => {
  it("prefers a selection, because the user already pointed at it", () => {
    expect(captureModeFor(page({ selection: { text: "x", truncated: false } }), false)).toBe(
      "selection"
    )
  })

  it("only ever sends the whole page on an explicit request", () => {
    const withBody = page({
      readableText: { text: "body", truncated: false, originalCharacterCount: 4 },
    })
    expect(captureModeFor(withBody, false)).toBe("metadata")
    expect(captureModeFor(withBody, true)).toBe("readable-page")
  })

  it("falls back to metadata when there is nothing else", () => {
    expect(captureModeFor(page(), true)).toBe("metadata")
  })
})

describe("pollIntervalFor", () => {
  it("polls fast while anything is in flight", () => {
    for (const status of ["submitting", "queued", "running", "needs_input"]) {
      expect(pollIntervalFor([{ status }])).toBe(POLL_ACTIVE_MS)
    }
  })

  it("backs off once everything is finished", () => {
    // A settled list is history, and history does not change; polling it every
    // three seconds is a request per user per three seconds for nothing.
    expect(pollIntervalFor([{ status: "completed" }, { status: "failed" }])).toBe(POLL_IDLE_MS)
    expect(pollIntervalFor([])).toBe(POLL_IDLE_MS)
  })

  it("polls fast when even one entry is still moving", () => {
    expect(pollIntervalFor([{ status: "completed" }, { status: "running" }])).toBe(POLL_ACTIVE_MS)
  })
})
