import { decideEscalation, documentConfidence, maybeEscalateResult } from "./confidence"
import type { OcrDocument, OcrResult, UserOcrSettings } from "./types"

function docWith(confidences: Array<number | undefined>): OcrDocument {
  return {
    pages: [
      {
        pageNumber: 1,
        blocks: confidences.map((c, i) => ({
          id: `0.${i}`,
          type: "paragraph" as const,
          text: "x",
          confidence: c,
          readingOrderIndex: i,
          provenance: { providerId: "ocrs", pageNumber: 1 },
        })),
      },
    ],
  }
}

function result(providerId: string, doc?: OcrDocument): OcrResult {
  return {
    providerId,
    pages: [],
    combinedMarkdown: "",
    combinedText: "",
    languages: ["en"],
    durationMs: 1,
    cached: false,
    document: doc,
  }
}

const settings = (over: Partial<UserOcrSettings> = {}): UserOcrSettings =>
  ({
    confidenceEscalation: "escalate",
    confidenceThreshold: 0.6,
    escalationProviderId: null,
    cloudFallbackProviderId: "mistral-ocr",
    ...over,
  }) as UserOcrSettings

describe("documentConfidence", () => {
  it("averages reported block confidences", () => {
    expect(documentConfidence(docWith([0.4, 0.6]))).toBeCloseTo(0.5)
  })
  it("returns null with no confidences or no document", () => {
    expect(documentConfidence(docWith([undefined, undefined]))).toBeNull()
    expect(documentConfidence(undefined)).toBeNull()
  })
})

describe("decideEscalation", () => {
  it("escalates a low-confidence result to the cloud fallback", () => {
    expect(
      decideEscalation({ settings: settings(), primaryProviderId: "ocrs", confidence: 0.4 })
    ).toEqual({
      escalate: true,
      toProviderId: "mistral-ocr",
    })
  })
  it("prefers an explicit escalationProviderId over the cloud fallback", () => {
    expect(
      decideEscalation({
        settings: settings({ escalationProviderId: "google-vision" }),
        primaryProviderId: "ocrs",
        confidence: 0.1,
      })
    ).toEqual({ escalate: true, toProviderId: "google-vision" })
  })
  it("does not escalate when off, above threshold, no signal, no target, or self-target", () => {
    expect(
      decideEscalation({
        settings: settings({ confidenceEscalation: "off" }),
        primaryProviderId: "ocrs",
        confidence: 0.1,
      }).escalate
    ).toBe(false)
    expect(
      decideEscalation({ settings: settings(), primaryProviderId: "ocrs", confidence: 0.9 })
        .escalate
    ).toBe(false)
    expect(
      decideEscalation({ settings: settings(), primaryProviderId: "ocrs", confidence: null })
        .escalate
    ).toBe(false)
    expect(
      decideEscalation({
        settings: settings({ cloudFallbackProviderId: null, escalationProviderId: null }),
        primaryProviderId: "ocrs",
        confidence: 0.1,
      }).escalate
    ).toBe(false)
    expect(
      decideEscalation({
        settings: settings({ escalationProviderId: "ocrs" }),
        primaryProviderId: "ocrs",
        confidence: 0.1,
      }).escalate
    ).toBe(false)
  })
})

describe("maybeEscalateResult", () => {
  it("returns the escalated result when triggered", async () => {
    const primary = result("ocrs", docWith([0.3]))
    const escalated = result("mistral-ocr", docWith([0.95]))
    const reextract = jest.fn(async () => escalated)
    const out = await maybeEscalateResult({ result: primary, settings: settings(), reextract })
    expect(out).toBe(escalated)
    expect(reextract).toHaveBeenCalledWith("mistral-ocr")
  })

  it("keeps the primary when escalation is not warranted", async () => {
    const primary = result("ocrs", docWith([0.9]))
    const reextract = jest.fn()
    expect(await maybeEscalateResult({ result: primary, settings: settings(), reextract })).toBe(
      primary
    )
    expect(reextract).not.toHaveBeenCalled()
  })

  it("falls back to the primary when the escalation re-run throws", async () => {
    const primary = result("ocrs", docWith([0.2]))
    const reextract = jest.fn(async () => {
      throw new Error("escalation provider down")
    })
    expect(await maybeEscalateResult({ result: primary, settings: settings(), reextract })).toBe(
      primary
    )
  })
})
