/** @jest-environment jsdom */

import type { UIMessage } from "ai"

import {
  beginOnboardingRequestAttempt,
  createOnboardingRequest,
  readOnboardingRequest,
  reconcileOnboardingRequestMessages,
} from "./request"

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
})

const assistant = (id: string, text: string, tool?: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [
    ...(tool
      ? [
          {
            type: `tool-${tool}`,
            toolCallId: `call-${id}`,
            state: "output-available",
            input: {},
            output: { ok: true },
          } as never,
        ]
      : []),
    { type: "text", text },
  ],
})

describe("durable onboarding request", () => {
  beforeEach(() => localStorage.clear())

  it("creates one idempotent request with its card, session, skill and prompt", () => {
    const first = createOnboardingRequest({
      cardId: "summarize-web",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Summarize a web page for me.",
      now: 1_000,
    })
    const replay = createOnboardingRequest({
      cardId: "summarize-web",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Summarize a web page for me.",
      now: 2_000,
    })

    expect(replay).toEqual(first)
    expect(readOnboardingRequest("s1")).toEqual(
      expect.objectContaining({
        state: "awaiting-input",
        attempts: 0,
        clarificationUsed: false,
        idempotencyKey: "onboarding:s1:summarize-web",
      })
    )
  })

  it("keeps the skill active across one path clarification, then succeeds on a read receipt", () => {
    createOnboardingRequest({
      cardId: "read-folder",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Read a folder on this machine.",
      now: 1_000,
    })
    beginOnboardingRequestAttempt("s1", { now: 1_100 })

    const clarification = [
      user("u1", "Read a folder on this machine."),
      assistant("a1", "Which folder should I read?"),
    ]
    expect(reconcileOnboardingRequestMessages("s1", clarification, { now: 1_200 })).toEqual(
      expect.objectContaining({
        state: "awaiting-input",
        clarificationUsed: true,
        baselineMessageIds: ["u1", "a1"],
      })
    )

    expect(beginOnboardingRequestAttempt("s1", { now: 1_300 })).toEqual(
      expect.objectContaining({ state: "in-flight", attempts: 2, clarificationUsed: true })
    )
    expect(
      reconcileOnboardingRequestMessages(
        "s1",
        [
          ...clarification,
          user("u2", "/work"),
          assistant("a2", "It contains src, tests and package.json.", "Read"),
        ],
        { now: 1_400 }
      )
    ).toEqual(
      expect.objectContaining({
        state: "succeeded",
        resultMessageId: "a2",
        toolReceiptIds: ["call-a2"],
      })
    )
  })

  it("does not settle OCR without a persisted successful OCR receipt", () => {
    createOnboardingRequest({
      cardId: "extract-text",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Take a screenshot and extract the text.",
      now: 1_000,
    })
    beginOnboardingRequestAttempt("s1", { now: 1_100 })

    expect(
      reconcileOnboardingRequestMessages(
        "s1",
        [user("u1", "Take a screenshot and extract the text."), assistant("a1", "Done")],
        { now: 1_200 }
      )
    ).toEqual(expect.objectContaining({ state: "failed", attempts: 1 }))
  })

  it("settles screenshot OCR only with capture and OCR evidence", () => {
    createOnboardingRequest({
      cardId: "extract-text",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Take a screenshot and extract the text.",
      now: 1_000,
    })
    beginOnboardingRequestAttempt("s1", { now: 1_100 })

    const result = reconcileOnboardingRequestMessages(
      "s1",
      [
        user("u1", "Take a screenshot and extract the text."),
        assistant("capture", "Captured.", "take_screenshot"),
        assistant("ocr", "Extracted text: Cognia", "ocr.extract"),
      ],
      { now: 1_200 }
    )
    expect(result).toEqual(
      expect.objectContaining({
        state: "succeeded",
        resultMessageId: "ocr",
        toolReceiptIds: ["call-capture", "call-ocr"],
      })
    )
  })

  it("counts a recovered in-flight dispatch as a new attempt after reload", () => {
    createOnboardingRequest({
      cardId: "extract-text",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Take a screenshot and extract the text.",
      now: 1_000,
    })
    beginOnboardingRequestAttempt("s1", { now: 1_100 })

    expect(beginOnboardingRequestAttempt("s1", { now: 2_000 })).toEqual(
      expect.objectContaining({ state: "in-flight", attempts: 2, dispatchedAt: 2_000 })
    )
  })

  it("fails after the single allowed clarification instead of asking forever", () => {
    createOnboardingRequest({
      cardId: "summarize-web",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Summarize a web page.",
      now: 1_000,
    })
    beginOnboardingRequestAttempt("s1", { now: 1_100 })
    const first = [user("u1", "Summarize a web page."), assistant("a1", "Which URL?")]
    reconcileOnboardingRequestMessages("s1", first, { now: 1_200 })
    beginOnboardingRequestAttempt("s1", { now: 1_300 })

    expect(
      reconcileOnboardingRequestMessages(
        "s1",
        [...first, user("u2", "https://example.com"), assistant("a2", "I could not fetch it.")],
        { now: 1_400 }
      )
    ).toEqual(expect.objectContaining({ state: "failed", clarificationUsed: true }))
  })

  it("does not mislabel a plain tool failure as the allowed clarification", () => {
    createOnboardingRequest({
      cardId: "summarize-web",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "Summarize a web page.",
      now: 1_000,
    })
    beginOnboardingRequestAttempt("s1", { now: 1_100 })

    expect(
      reconcileOnboardingRequestMessages(
        "s1",
        [user("u1", "Summarize a web page."), assistant("a1", "Web access is unavailable.")],
        { now: 1_200 }
      )
    ).toEqual(expect.objectContaining({ state: "failed", clarificationUsed: false }))
  })
})
