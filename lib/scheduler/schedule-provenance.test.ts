import {
  payloadWithTrustedProvenance,
  readScheduleProvenance,
  SCHEDULE_PROVENANCE_KEY,
  withoutScheduleProvenance,
  type ImScheduleProvenance,
} from "./schedule-provenance"

const provenance: ImScheduleProvenance = {
  source: "im",
  adapterId: "bot",
  conversationKey: "telegram:bot:chat",
  senderId: "alice",
}

describe("readScheduleProvenance", () => {
  it("reads a well-formed provenance", () => {
    expect(readScheduleProvenance({ payload: { [SCHEDULE_PROVENANCE_KEY]: provenance } })).toEqual(
      provenance
    )
  })

  it("rejects a missing, partial or foreign-shaped value", () => {
    expect(readScheduleProvenance({})).toBeNull()
    expect(readScheduleProvenance({ payload: {} })).toBeNull()
    for (const bad of [
      null,
      "telegram:bot:chat",
      { ...provenance, source: "web" },
      { ...provenance, conversationKey: "" },
      { ...provenance, senderId: 7 },
      [provenance],
    ]) {
      expect(readScheduleProvenance({ payload: { [SCHEDULE_PROVENANCE_KEY]: bad } })).toBeNull()
    }
  })
})

describe("withoutScheduleProvenance", () => {
  it("drops the key and keeps every other field", () => {
    expect(
      withoutScheduleProvenance({ prompt: "p", [SCHEDULE_PROVENANCE_KEY]: provenance })
    ).toEqual({ prompt: "p" })
  })

  it("returns the same object or undefined when there is nothing to drop", () => {
    const payload = { prompt: "p" }
    expect(withoutScheduleProvenance(payload)).toBe(payload)
    expect(withoutScheduleProvenance(undefined)).toBeUndefined()
  })
})

describe("payloadWithTrustedProvenance", () => {
  it("replaces a payload-supplied provenance with the trusted one", () => {
    const forged = { ...provenance, conversationKey: "telegram:bot:elsewhere" }
    expect(
      payloadWithTrustedProvenance({ prompt: "p", [SCHEDULE_PROVENANCE_KEY]: forged }, provenance)
    ).toEqual({ prompt: "p", [SCHEDULE_PROVENANCE_KEY]: provenance })
  })

  it("removes a payload-supplied provenance when there is no trusted one", () => {
    expect(
      payloadWithTrustedProvenance(
        { prompt: "p", [SCHEDULE_PROVENANCE_KEY]: provenance },
        undefined
      )
    ).toEqual({ prompt: "p" })
    expect(payloadWithTrustedProvenance(undefined, undefined)).toBeUndefined()
  })

  it("creates a payload to carry the trusted provenance", () => {
    expect(payloadWithTrustedProvenance(undefined, provenance)).toEqual({
      [SCHEDULE_PROVENANCE_KEY]: provenance,
    })
  })
})
