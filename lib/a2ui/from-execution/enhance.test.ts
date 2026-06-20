import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii, redactText } from "@/lib/twin/ingest/redact"

import { enhanceExecutionPage, parseEnhancementResponse, sanitizeDigest } from "./enhance"

jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn() }))
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: jest.fn(() => true),
  redactText: jest.fn((t: string) => ({ redacted: t, map: {} })),
}))

const mockBuild = buildUtilityLlmClient as jest.MockedFunction<typeof buildUtilityLlmClient>
const mockGate = hasNoLeakingPii as jest.MockedFunction<typeof hasNoLeakingPii>
const mockRedact = redactText as jest.MockedFunction<typeof redactText>

function fakeClient(complete: jest.Mock) {
  return { complete } as unknown as ReturnType<typeof buildUtilityLlmClient>
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGate.mockReturnValue(true)
  mockRedact.mockImplementation((t: string) => ({ redacted: t, map: {} }))
})

describe("parseEnhancementResponse", () => {
  it("parses strict JSON", () => {
    expect(parseEnhancementResponse('{"title":"T","summary":"S","insights":["a","b"]}')).toEqual({
      title: "T",
      summary: "S",
      insights: ["a", "b"],
    })
  })
  it("strips a json code fence", () => {
    expect(parseEnhancementResponse('```json\n{"summary":"S"}\n```')).toMatchObject({
      summary: "S",
      insights: [],
    })
  })
  it("treats non-JSON as a bare summary", () => {
    expect(parseEnhancementResponse("just a sentence")).toEqual({
      summary: "just a sentence",
      insights: [],
    })
  })
  it("returns null for empty and for JSON missing a summary", () => {
    expect(parseEnhancementResponse("   ")).toBeNull()
    expect(parseEnhancementResponse('{"insights":["x"]}')).toBeNull()
  })
  it("drops non-string insights", () => {
    expect(parseEnhancementResponse('{"summary":"S","insights":["a",2,"",null]}')).toEqual({
      title: undefined,
      summary: "S",
      insights: ["a"],
    })
  })
})

describe("sanitizeDigest", () => {
  it("returns trimmed text when already clean", () => {
    expect(sanitizeDigest("  hello  ")).toBe("hello")
    expect(mockRedact).not.toHaveBeenCalled()
  })
  it("redacts when the raw text leaks but the redacted text is clean", () => {
    mockGate.mockReturnValueOnce(false).mockReturnValueOnce(true)
    mockRedact.mockReturnValueOnce({ redacted: "REDACTED", map: {} })
    expect(sanitizeDigest("leaky")).toBe("REDACTED")
  })
  it("returns null when redaction still leaks", () => {
    mockGate.mockReturnValue(false)
    expect(sanitizeDigest("very leaky")).toBeNull()
  })
  it("returns null for empty input", () => {
    expect(sanitizeDigest("   ")).toBeNull()
  })
})

describe("enhanceExecutionPage", () => {
  const baseArgs = { digest: "a digest", session: null, appSettings: null }

  it("returns the parsed enhancement on success", async () => {
    const complete = jest.fn().mockResolvedValue('{"summary":"All good"}')
    mockBuild.mockReturnValue(fakeClient(complete))
    const result = await enhanceExecutionPage(baseArgs)
    expect(result).toMatchObject({ summary: "All good" })
    expect(complete).toHaveBeenCalledWith("a digest", expect.objectContaining({ temperature: 0 }))
  })

  it("returns null when the PII gate blocks the digest (no client call)", async () => {
    mockGate.mockReturnValue(false)
    const complete = jest.fn()
    mockBuild.mockReturnValue(fakeClient(complete))
    expect(await enhanceExecutionPage(baseArgs)).toBeNull()
    expect(mockBuild).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it("returns null when no client resolves", async () => {
    mockBuild.mockReturnValue(null)
    expect(await enhanceExecutionPage(baseArgs)).toBeNull()
  })

  it("returns null (never throws) when the provider call fails", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("rate limit"))
    mockBuild.mockReturnValue(fakeClient(complete))
    expect(await enhanceExecutionPage(baseArgs)).toBeNull()
  })

  it("returns null for an empty digest", async () => {
    expect(await enhanceExecutionPage({ ...baseArgs, digest: "  " })).toBeNull()
    expect(mockBuild).not.toHaveBeenCalled()
  })
})
