/**
 * Tests for the PII-aware safeSendPrompt wrapper.
 *
 * We mock both `runAndCaptureAssistantReply` and `appendAudit` so the
 * tests stay in-process (no Dexie writes, no event subscription).
 */

import { PiiGateBlocked, isPiiSafeSendContent, safeSendPrompt } from "./safe-send-prompt"

jest.mock("@/lib/claude/run-and-capture", () => {
  return {
    __esModule: true,
    RunAndCaptureError: class RunAndCaptureError extends Error {},
    runAndCaptureAssistantReply: jest.fn(async () => ({
      text: "model reply",
      messageId: "msg-1",
    })),
  }
})

jest.mock("@/lib/connectors/audit", () => {
  return {
    __esModule: true,
    appendAudit: jest.fn(async () => undefined),
  }
})

jest.mock("@/lib/db/session-usage", () => {
  return {
    __esModule: true,
    recordConnectorUsage: jest.fn(async () => ({ messageId: "conn-row" })),
    swallowUsageWrite: jest.fn(),
  }
})

jest.mock("@/lib/claude/provider-telemetry", () => {
  return {
    __esModule: true,
    recordProviderOutcome: jest.fn(),
  }
})

import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { appendAudit } from "@/lib/connectors/audit"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { recordConnectorUsage, swallowUsageWrite } from "@/lib/db/session-usage"

const mockRun = runAndCaptureAssistantReply as jest.MockedFunction<
  typeof runAndCaptureAssistantReply
>
const mockAudit = appendAudit as jest.MockedFunction<typeof appendAudit>
const mockRecordConnectorUsage = recordConnectorUsage as jest.MockedFunction<
  typeof recordConnectorUsage
>
const mockSwallowUsageWrite = swallowUsageWrite as jest.MockedFunction<typeof swallowUsageWrite>
const mockRecordProviderOutcome = recordProviderOutcome as jest.MockedFunction<
  typeof recordProviderOutcome
>

beforeEach(() => {
  mockRun.mockClear()
  mockAudit.mockClear()
  mockRecordConnectorUsage.mockClear()
  mockSwallowUsageWrite.mockClear()
  mockRecordProviderOutcome.mockClear()
})

describe("isPiiSafeSendContent", () => {
  it("accepts a clean string prompt", () => {
    expect(isPiiSafeSendContent("hello there")).toBe(true)
  })

  it("rejects a string prompt containing an email", () => {
    expect(isPiiSafeSendContent("ping me at user@example.com")).toBe(false)
  })

  it("walks SendContentBlock[] arrays — accepts a clean block list", () => {
    expect(isPiiSafeSendContent([{ type: "text", text: "all good" }] as never)).toBe(true)
  })

  it("walks SendContentBlock[] arrays — rejects on any tainted text block", () => {
    expect(
      isPiiSafeSendContent([
        { type: "text", text: "fine" },
        { type: "text", text: "leak: user@example.com" },
      ] as never)
    ).toBe(false)
  })

  it("ignores non-text blocks (image / file) on the gate path", () => {
    expect(
      isPiiSafeSendContent([
        { type: "text", text: "ok" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "Zm9v" },
        } as never,
      ] as never)
    ).toBe(true)
  })

  it("treats unrecognised content shapes as safe by default", () => {
    expect(isPiiSafeSendContent(null as unknown as string)).toBe(true)
  })
})

describe("safeSendPrompt", () => {
  const auditCtx = { adapterId: "adp_1", conversationKey: "telegram:adp_1:c1" }

  it("delegates to runAndCaptureAssistantReply when prompt is clean", async () => {
    const result = await safeSendPrompt("sess_1", "hello", undefined, auditCtx)
    expect(result).toEqual({ text: "model reply", messageId: "msg-1" })
    expect(mockRun).toHaveBeenCalledWith("sess_1", "hello", undefined, expect.any(Object))
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("aborts before sendPrompt when prompt carries PII and audits with reason=pii_blocked", async () => {
    await expect(
      safeSendPrompt("sess_1", "email me at user@example.com", undefined, auditCtx)
    ).rejects.toBeInstanceOf(PiiGateBlocked)
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledTimes(1)
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:c1",
      kind: "adapter.error",
      reason: "pii_blocked",
    })
  })

  it("aborts when options.appendSystemPrompt leaks PII", async () => {
    await expect(
      safeSendPrompt(
        "sess_1",
        "clean prompt",
        // Build-options injected a capability prompt that accidentally
        // embedded a user contact — should still abort.
        { appendSystemPrompt: "respond as user@example.com would" },
        auditCtx
      )
    ).rejects.toBeInstanceOf(PiiGateBlocked)
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "pii_blocked",
        message: expect.stringContaining("appendSystemPrompt"),
      })
    )
  })

  it("propagates RunAndCaptureError from the underlying call", async () => {
    const err = new Error("kaboom")
    mockRun.mockRejectedValueOnce(err)
    await expect(safeSendPrompt("sess_1", "clean", undefined, auditCtx)).rejects.toThrow("kaboom")
    // No PII gate audit: the failure happened past the gate.
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("passes signal + timeoutMs through to the underlying call", async () => {
    const ac = new AbortController()
    await safeSendPrompt("sess_1", "clean", undefined, {
      ...auditCtx,
      signal: ac.signal,
      timeoutMs: 10_000,
    })
    expect(mockRun).toHaveBeenCalledWith(
      "sess_1",
      "clean",
      undefined,
      expect.objectContaining({ signal: ac.signal, timeoutMs: 10_000 })
    )
  })

  it("records connector usage and provider telemetry when the captured result includes usage", async () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
      totalCostUsd: 0.012,
      durationMs: 750,
    }
    mockRun.mockResolvedValueOnce({
      text: "model reply",
      messageId: "msg-usage",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      usage,
    })

    const result = await safeSendPrompt(
      "sess_1",
      "clean",
      { provider: "openai", model: "gpt-4o" },
      auditCtx
    )

    expect(result.usage).toBe(usage)
    expect(mockRecordConnectorUsage).toHaveBeenCalledWith({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:c1",
      usage,
    })
    expect(mockSwallowUsageWrite).toHaveBeenCalledWith(expect.any(Promise))
    expect(mockRecordProviderOutcome).toHaveBeenCalledWith({
      providerId: "openai",
      ok: true,
      latencyMs: 750,
      estimatedCostUsd: 0.012,
      modelId: "gpt-4o",
      tokensUsed: 125,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
      sessionId: "sess_1",
    })
  })

  it("does not write usage telemetry when the captured result has no usage", async () => {
    await safeSendPrompt("sess_1", "clean", undefined, auditCtx)

    expect(mockRecordConnectorUsage).not.toHaveBeenCalled()
    expect(mockSwallowUsageWrite).not.toHaveBeenCalled()
    expect(mockRecordProviderOutcome).not.toHaveBeenCalled()
  })

  it("records connector usage without provider outcome when provider is unresolved", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 0.002,
      durationMs: 100,
    }
    mockRun.mockResolvedValueOnce({
      text: "model reply",
      messageId: "msg-usage",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      usage,
    })

    await safeSendPrompt("sess_1", "clean", undefined, auditCtx)

    expect(mockRecordConnectorUsage).toHaveBeenCalledWith({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:c1",
      usage,
    })
    expect(mockRecordProviderOutcome).not.toHaveBeenCalled()
  })
})
