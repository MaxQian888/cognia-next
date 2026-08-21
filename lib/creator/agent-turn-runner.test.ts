const mockPii = jest.fn((_text: string) => true)
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: (text: string) => mockPii(text) }))

const mockRun = jest.fn(
  async (_sessionId: string, _prompt: unknown, _options?: unknown, _cap?: unknown) => ({
    text: "reply",
  })
)
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...args: unknown[]) =>
    mockRun(...(args as Parameters<typeof mockRun>)),
}))

// A deliberately WIDE resolved default, so the test proves the runner narrows
// it rather than merely inheriting something that happened to be safe.
const mockResolve = jest.fn(async () => ({
  permissionMode: "bypassPermissions",
  allowedTools: ["Read", "Write", "Bash"],
  cwd: "/somewhere/else",
  model: "claude-x",
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...args: unknown[]) =>
    mockResolve(...(args as Parameters<typeof mockResolve>)),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))

import {
  CREATOR_AGENT_AUTHORITY,
  CREATOR_AGENT_TOOLS,
  CreatorPiiBlockedError,
  createCreatorTurnRunner,
} from "./agent-turn-runner"

function request(
  overrides: Partial<Parameters<ReturnType<typeof createCreatorTurnRunner>>[0]> = {}
) {
  return {
    purpose: "plan" as const,
    prompt: "generate a thing",
    cwd: "/work/authoring",
    label: "Creator scaffold",
    ...overrides,
  }
}

beforeEach(() => {
  mockPii.mockReturnValue(true)
  mockRun.mockClear()
  mockResolve.mockClear()
})

/** The SendOptions the runner actually handed to the capture call. */
function sentOptions(call = 0) {
  return mockRun.mock.calls[call][2] as Record<string, unknown>
}

function sentSessionId(call = 0) {
  return mockRun.mock.calls[call][0] as string
}

describe("createCreatorTurnRunner", () => {
  it("returns the assistant text", async () => {
    await expect(createCreatorTurnRunner()(request())).resolves.toBe("reply")
  })

  // The red line: locally-derived text passes the gate before it reaches a
  // provider, and a block means we never send at all.
  it("refuses to send when the PII gate blocks the prompt", async () => {
    mockPii.mockReturnValue(false)
    await expect(createCreatorTurnRunner()(request())).rejects.toThrow(CreatorPiiBlockedError)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("names the purpose in the PII refusal", async () => {
    mockPii.mockReturnValue(false)
    await expect(createCreatorTurnRunner()(request({ purpose: "review" }))).rejects.toThrow(
      /review prompt was blocked/
    )
  })

  // The generator proposes; only `writeCreatorFile` writes. A turn that could
  // write directly would bypass the permission diff entirely.
  it("narrows a wide resolved permission mode down to plan", async () => {
    await createCreatorTurnRunner()(request())
    expect(sentOptions().permissionMode).toBe(CREATOR_AGENT_AUTHORITY)
    expect(CREATOR_AGENT_AUTHORITY).toBe("plan")
  })

  it("replaces a wide resolved tool set with the read-only one", async () => {
    await createCreatorTurnRunner()(request())
    expect(sentOptions().allowedTools).toEqual([...CREATOR_AGENT_TOOLS])
    expect(sentOptions().allowedTools).not.toContain("Write")
    expect(sentOptions().allowedTools).not.toContain("Bash")
  })

  it("overrides the resolved cwd with the authoring root", async () => {
    await createCreatorTurnRunner()(request())
    expect(sentOptions().cwd).toBe("/work/authoring")
  })

  it("keeps unrelated resolved options", async () => {
    await createCreatorTurnRunner()(request())
    expect(sentOptions().model).toBe("claude-x")
  })

  it("labels the turn for the execution broker", async () => {
    await createCreatorTurnRunner()(request({ label: "Creator survey (plugin)" }))
    const cap = mockRun.mock.calls[0][3] as { execution: { kind: string; label: string } }
    expect(cap.execution).toEqual({ kind: "subagent", label: "Creator survey (plugin)" })
  })

  it("shares one session between the survey and the plan", async () => {
    const runner = createCreatorTurnRunner()
    await runner(request({ purpose: "survey" }))
    await runner(request({ purpose: "plan" }))
    expect(sentSessionId(0)).toBe(sentSessionId(1))
  })

  // Independent context is the property that makes the review worth running.
  it("gives the reviewer a session the generator never touched", async () => {
    const runner = createCreatorTurnRunner()
    await runner(request({ purpose: "plan" }))
    await runner(request({ purpose: "review" }))
    expect(sentSessionId(1)).not.toBe(sentSessionId(0))
    expect(sentSessionId(1)).toMatch(/^creator-review-/)
  })

  it("gives each review its own fresh session", async () => {
    const runner = createCreatorTurnRunner()
    await runner(request({ purpose: "review" }))
    await runner(request({ purpose: "review" }))
    expect(sentSessionId(0)).not.toBe(sentSessionId(1))
  })

  // A caller cannot hand the reviewer the generator's session even by trying.
  it("ignores a supplied session id for the review turn", async () => {
    const runner = createCreatorTurnRunner({ authoringSessionId: "shared-session" })
    await runner(request({ purpose: "plan" }))
    await runner(request({ purpose: "review" }))
    expect(sentSessionId(0)).toBe("shared-session")
    expect(sentSessionId(1)).not.toBe("shared-session")
  })

  it("threads the abort signal through", async () => {
    const controller = new AbortController()
    await createCreatorTurnRunner({ signal: controller.signal })(request())
    const cap = mockRun.mock.calls[0][3] as { signal?: AbortSignal }
    expect(cap.signal).toBe(controller.signal)
  })
})
