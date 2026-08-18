/** Metering wrapper around `@cognia/ocr`'s `extract`. */
import type { OcrResult } from "@cognia/ocr/types"

const extractCoreMock = jest.fn<Promise<OcrResult>, [unknown, unknown]>()
const recordSurfaceUsageMock = jest.fn<Promise<null>, [Record<string, unknown>]>()

jest.mock("@cognia/ocr", () => ({
  __esModule: true,
  extract: (input: unknown, deps: unknown) => extractCoreMock(input, deps),
}))

jest.mock("@/lib/db/session-usage", () => ({
  recordSurfaceUsage: (args: Record<string, unknown>) => recordSurfaceUsageMock(args),
  swallowUsageWrite: (p: Promise<unknown>) => void p.catch(() => {}),
}))

import { extract } from "./index"

function result(over: Partial<OcrResult> = {}): OcrResult {
  return {
    providerId: "mistral-ocr",
    pages: [
      { pageNumber: 1, markdown: "a", text: "a" },
      { pageNumber: 2, markdown: "b", text: "b" },
    ],
    combinedMarkdown: "a\nb",
    combinedText: "a\nb",
    languages: ["eng"],
    durationMs: 1_200,
    cached: false,
    ...over,
  } as OcrResult
}

beforeEach(() => {
  extractCoreMock.mockReset()
  recordSurfaceUsageMock.mockReset()
  recordSurfaceUsageMock.mockResolvedValue(null)
})

it("meters the pages a fresh extraction billed", async () => {
  extractCoreMock.mockResolvedValue(result())
  await extract({ source: {} } as never, {} as never)
  expect(recordSurfaceUsageMock).toHaveBeenCalledTimes(1)
  const args = recordSurfaceUsageMock.mock.calls[0][0] as {
    surface: string
    scopeId: string
    usage: { unitBreakdown: { pages: number }; durationMs: number }
  }
  expect(args.surface).toBe("ocr")
  expect(args.scopeId).toBe("mistral-ocr")
  expect(args.usage.unitBreakdown.pages).toBe(2)
  expect(args.usage.durationMs).toBe(1_200)
})

it("does not meter a cached result", async () => {
  extractCoreMock.mockResolvedValue(result({ cached: true }))
  await extract({ source: {} } as never, {} as never)
  // Re-reading the same document must not make it look more expensive.
  expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
})

it("does not meter an extraction that produced no pages", async () => {
  extractCoreMock.mockResolvedValue(result({ pages: [] }))
  await extract({ source: {} } as never, {} as never)
  expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
})

it("carries the provider's own USD projection as an authoritative cost", async () => {
  extractCoreMock.mockResolvedValue(
    result({ costEstimate: { unit: "page", amount: 0.36, currency: "USD" } })
  )
  await extract({ source: {} } as never, {} as never)
  const usage = (recordSurfaceUsageMock.mock.calls[0][0] as { usage: Record<string, unknown> })
    .usage
  expect(usage.costUsd).toBeCloseTo(0.36)
  expect(usage.costSource).toBe("sdk")
  expect(usage.costKnown).toBe(true)
})

it("marks an unpriced extraction unknown rather than free", async () => {
  extractCoreMock.mockResolvedValue(result())
  await extract({ source: {} } as never, {} as never)
  const usage = (recordSurfaceUsageMock.mock.calls[0][0] as { usage: Record<string, unknown> })
    .usage
  expect(usage.costUsd).toBeUndefined()
  expect(usage.costKnown).toBe(false)
})

it("gives the same document the same operation id so a re-run overwrites", async () => {
  extractCoreMock.mockResolvedValue(result())
  await extract({ source: {} } as never, {} as never)
  await extract({ source: {} } as never, {} as never)
  const [first, second] = recordSurfaceUsageMock.mock.calls.map(
    (call) => (call[0] as { operationId: string }).operationId
  )
  expect(first).toBe(second)
})

it("gives a different document a different operation id", async () => {
  extractCoreMock.mockResolvedValue(result())
  await extract({ source: {} } as never, {} as never)
  extractCoreMock.mockResolvedValue(result({ combinedText: "totally different" }))
  await extract({ source: {} } as never, {} as never)
  const [first, second] = recordSurfaceUsageMock.mock.calls.map(
    (call) => (call[0] as { operationId: string }).operationId
  )
  expect(first).not.toBe(second)
})

it("returns the core result untouched", async () => {
  const out = result()
  extractCoreMock.mockResolvedValue(out)
  await expect(extract({ source: {} } as never, {} as never)).resolves.toBe(out)
})

it("propagates the core's failure without metering", async () => {
  extractCoreMock.mockRejectedValue(new Error("provider down"))
  await expect(extract({ source: {} } as never, {} as never)).rejects.toThrow("provider down")
  expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
})
