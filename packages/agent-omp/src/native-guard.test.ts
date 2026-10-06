import {
  createOmpNativeGuard,
  type OmpGuardContext,
  type OmpGuardEvent,
  type OmpGuardOptions,
} from "./native-guard"

function setup(overrides: Partial<OmpGuardOptions> = {}) {
  const options: OmpGuardOptions = {
    nonce: "nonce-123",
    enforcement: {
      isolatedExtensions: true,
      providerEgressControlled: true,
      rebindingVerified: true,
    },
    authorize: jest.fn(async () => ({ allow: true })),
    redactResult: jest.fn(async (result) => result),
    transformOutbound: jest.fn((payload) => payload),
    terminate: jest.fn(),
    ...overrides,
  }
  const handlers = new Map<string, (event: OmpGuardEvent, ctx: OmpGuardContext) => unknown>()
  createOmpNativeGuard(options)({
    on: (event, handler) => {
      handlers.set(event, handler)
    },
  })
  const ctx: OmpGuardContext = {
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    abort: jest.fn(),
    ui: { setStatus: jest.fn() },
  }
  const call = (type: string, extra: Record<string, unknown> = {}, context = ctx) =>
    handlers.get(type)!({ type, ...extra }, context)
  return { options, handlers, ctx, call }
}

describe("OMP native protection extension", () => {
  it("rejects unproven host controls and missing callbacks before registering", () => {
    expect(() =>
      setup({
        enforcement: {
          isolatedExtensions: false,
          providerEgressControlled: true,
          rebindingVerified: true,
        },
      })
    ).toThrow("enforcement")
    expect(() =>
      setup({ transformOutbound: undefined } as unknown as Partial<OmpGuardOptions>)
    ).toThrow("transformOutbound")
  })
  it("announces its nonce only after registering protection hooks", async () => {
    const { call, ctx, handlers } = setup()
    expect(handlers.has("tool_call")).toBe(true)
    expect(handlers.has("before_provider_request")).toBe(true)
    await call("session_start")
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("cognia-omp-ready", "nonce-123")
    await call("session_switch")
    await call("session_branch")
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(3)
  })
  it("fails closed on denied, rejected or malformed tool authorization", async () => {
    for (const authorize of [
      async () => ({ allow: false }),
      async () => {
        throw new Error("secret reason")
      },
      async () => undefined,
    ]) {
      const { call } = setup({ authorize: authorize as OmpGuardOptions["authorize"] })
      expect(
        await call("tool_call", {
          toolName: "bash",
          toolCallId: "t",
          input: { command: "rm file" },
        })
      ).toMatchObject({ block: true })
    }
  })
  it("passes nested agent identity through authorization without assuming depth means top-level", async () => {
    const { call, ctx, options } = setup()
    const child = {
      ...ctx,
      agent: { kind: "sub" as const, id: "advisor", name: "advisor", depth: 0, parentId: "main" },
    }
    expect(
      await call("tool_call", { toolName: "read", toolCallId: "t", input: {} }, child)
    ).toEqual({ block: false })
    expect(options.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "read" }),
      child,
      expect.any(AbortSignal)
    )
  })
  it("replaces sensitive results and never returns original data after sanitizer failure", async () => {
    const { call } = setup({
      redactResult: async () => {
        throw new Error("secret")
      },
    })
    const result = await call("tool_result", {
      toolName: "read",
      content: [{ type: "text", text: "sensitive" }],
      details: { sensitive: true },
      isError: false,
    })
    expect(result).toMatchObject({ isError: true, details: {} })
    expect(JSON.stringify(result)).not.toMatch(/sensitive|secret/)
  })
  it("denies direct commands without an executor even when authorization allows", async () => {
    const { call } = setup()
    expect(await call("user_bash", { command: "touch x" })).toMatchObject({
      result: { exitCode: 1 },
    })
    expect(await call("user_python", { code: "print(1)" })).toMatchObject({
      result: { exitCode: 1, displayOutputs: [] },
    })
  })
  it("executes approved direct commands only through the host and redacts the result", async () => {
    const executeDirect = jest.fn(async () => ({
      output: "secret",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      totalLines: 1,
      totalBytes: 6,
      outputLines: 1,
      outputBytes: 6,
    }))
    const { call, options } = setup({
      executeDirect,
      redactResult: async (result) => ({ ...result, output: "clean" }),
    })
    expect(await call("user_bash", { command: "echo secret" })).toMatchObject({
      result: { output: "clean", exitCode: 0 },
    })
    expect(options.authorize).toHaveBeenCalledTimes(1)
    expect(executeDirect).toHaveBeenCalledTimes(1)
  })
  it("denies rejected executors and policy timeouts without upstream fallthrough", async () => {
    const { call } = setup({
      timeoutMs: 5,
      executeDirect: async () => {
        throw new Error("secret")
      },
    })
    expect(await call("user_python", { code: "print(1)" })).toMatchObject({
      result: { exitCode: 1 },
    })
    const hung = setup({ timeoutMs: 5, authorize: () => new Promise(() => {}) })
    expect(await hung.call("tool_call", { toolName: "bash", input: {} })).toMatchObject({
      block: true,
    })
  })
  it("transforms provider payload synchronously and terminates on failure or async callbacks", () => {
    const good = setup({ transformOutbound: () => ({ messages: ["redacted"] }) })
    expect(good.call("before_provider_request", { payload: { messages: ["secret"] } })).toEqual({
      messages: ["redacted"],
    })
    for (const transformOutbound of [
      () => {
        throw new Error("secret")
      },
      () => undefined,
      () => Promise.resolve({}),
    ]) {
      const { call, options, ctx } = setup({ transformOutbound })
      expect(call("before_provider_request", { payload: { messages: ["secret"] } })).toEqual({})
      expect(options.terminate).toHaveBeenCalledTimes(1)
      expect(ctx.abort).toHaveBeenCalledTimes(1)
    }
  })
})
