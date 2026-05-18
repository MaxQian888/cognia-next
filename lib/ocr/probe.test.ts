import { probeOcrProvider, PROBE_PNG_DATA_URL, type ProbeOutcome } from "./probe"
import { OcrError, type OcrInput } from "./types"
import type { ExtractDeps } from "./index"

function fakeDeps(): ExtractDeps {
  // The probe never touches these — we stub `extract` itself.
  return {
    registry: {} as ExtractDeps["registry"],
    settings: {} as ExtractDeps["settings"],
    platform: "web",
    credentialsResolver: async () => ({ secrets: {} }),
  }
}

/** Pulls the OcrInput argument out of a jest.fn() stub call, typed. */
function firstInput(stub: jest.Mock): OcrInput {
  const calls = stub.mock.calls as unknown as Array<[OcrInput, unknown]>
  if (calls.length === 0) throw new Error("extract stub was never called")
  return calls[0]![0]
}

describe("probeOcrProvider", () => {
  it("returns ok when extract resolves", async () => {
    const extractImpl = jest.fn(async () => ({
      providerId: "mistral-ocr",
      pages: [],
      combinedMarkdown: "",
      combinedText: "",
      languages: ["en"],
      durationMs: 0,
      cached: false,
    }))
    const outcome: ProbeOutcome = await probeOcrProvider("mistral-ocr", fakeDeps(), {
      __extractImpl: extractImpl as never,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    expect(extractImpl).toHaveBeenCalledTimes(1)
    const input = firstInput(extractImpl)
    expect(input.providerId).toBe("mistral-ocr")
    expect(input.useCache).toBe(false)
    expect(input.source).toEqual({
      kind: "data-url",
      dataUrl: PROBE_PNG_DATA_URL,
      mimeType: "image/png",
    })
  })

  it("surfaces OcrError discriminant verbatim", async () => {
    const extractImpl = jest.fn(async () => {
      throw new OcrError("missing_credentials", "google-vision", "no key")
    })
    const outcome = await probeOcrProvider("google-vision", fakeDeps(), {
      __extractImpl: extractImpl as never,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toEqual({ code: "missing_credentials", message: "no key" })
  })

  it("duck-types cross-realm OcrError instances", async () => {
    // Jest sometimes re-resolves @/lib/ocr/types through a different require
    // chain, producing an OcrError that's not instanceof the imported class.
    // We accept those via duck-typing too.
    const lookAlike = Object.assign(new Error("rate-limited via duck-type"), {
      name: "OcrError",
      code: "rate_limited",
      providerId: "openai-vision",
    })
    const extractImpl = jest.fn(async () => {
      throw lookAlike
    })
    const outcome = await probeOcrProvider("openai-vision", fakeDeps(), {
      __extractImpl: extractImpl as never,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toEqual({ code: "rate_limited", message: "rate-limited via duck-type" })
  })

  it("wraps generic errors as provider_failed", async () => {
    const extractImpl = jest.fn(async () => {
      throw new Error("kaboom")
    })
    const outcome = await probeOcrProvider("mistral-ocr", fakeDeps(), {
      __extractImpl: extractImpl as never,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toEqual({ code: "provider_failed", message: "kaboom" })
  })

  it("coerces non-Error throws to their string form", async () => {
    const extractImpl = jest.fn(async () => {
      throw "weird"
    })
    const outcome = await probeOcrProvider("mistral-ocr", fakeDeps(), {
      __extractImpl: extractImpl as never,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe("provider_failed")
    expect(outcome.error?.message).toBe("weird")
  })

  it("respects an explicit useCache override", async () => {
    const extractImpl = jest.fn(async () => ({
      providerId: "mistral-ocr",
      pages: [],
      combinedMarkdown: "",
      combinedText: "",
      languages: [],
      durationMs: 0,
      cached: false,
    }))
    await probeOcrProvider("mistral-ocr", fakeDeps(), {
      __extractImpl: extractImpl as never,
      useCache: true,
    })
    const input = firstInput(extractImpl)
    expect(input.useCache).toBe(true)
  })
})
