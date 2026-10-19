import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  EXECUTION_ENHANCE_PROMPT,
  enhanceExecutionPage,
  parseEnhancementResponse,
  sanitizeDigest,
} from "./enhance"

jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn() }))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: jest.fn(() => true),
  redactText: jest.fn((t: string) => ({ redacted: t, map: {} })),
}))

const mockBuild = buildUtilityLlmClient as jest.MockedFunction<typeof buildUtilityLlmClient>
const mockGate = hasNoLeakingPii as jest.MockedFunction<typeof hasNoLeakingPii>
const mockRedact = redactText as jest.MockedFunction<typeof redactText>

function fakeClient(complete: jest.Mock) {
  return { complete } as unknown as ReturnType<typeof buildUtilityLlmClient>
}

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

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

  it("sends the shipped analyst instructions", async () => {
    const complete = jest.fn().mockResolvedValue('{"summary":"ok"}')
    mockBuild.mockReturnValue(fakeClient(complete))
    await enhanceExecutionPage(baseArgs)
    expect(complete.mock.calls[0][1].system).toBe(EXECUTION_ENHANCE_PROMPT.defaultBody)
  })

  it("sends the source chat's published override", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: EXECUTION_ENHANCE_PROMPT.id,
          scope: "session",
          targetId: "s-1",
          revisionId: "por-enhance-session",
          body: 'Terse JSON {"title", "summary", "insights"} only.',
          contractVersion: EXECUTION_ENHANCE_PROMPT.contractVersion,
        },
      ])
    )
    const complete = jest.fn().mockResolvedValue('{"summary":"ok"}')
    mockBuild.mockReturnValue(fakeClient(complete))
    const session = { id: "s-1", title: "t", createdAt: 1, updatedAt: 1 } as ChatSession
    await enhanceExecutionPage({ ...baseArgs, session })
    expect(complete.mock.calls[0][1].system).toBe(
      'Terse JSON {"title", "summary", "insights"} only.'
    )
    await enhanceExecutionPage(baseArgs)
    expect(complete.mock.calls[1][1].system).toBe(EXECUTION_ENHANCE_PROMPT.defaultBody)
  })

  it("returns null without a call when aborted while the prompt resolves", async () => {
    const controller = new AbortController()
    controller.abort()
    const complete = jest.fn()
    mockBuild.mockReturnValue(fakeClient(complete))
    expect(await enhanceExecutionPage({ ...baseArgs, abortSignal: controller.signal })).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })
})
