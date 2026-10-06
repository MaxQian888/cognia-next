import { OmpOperationAdapter, OmpQueueClearError } from "./session-operations"
import { OmpSessionClient, type OmpRequestDispatch } from "./session-client"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
class TestAdapter extends OmpOperationAdapter {
  readonly protocol = "test"
  constructor(private client: OmpSessionClient) {
    super()
  }
  getOmpSession() {
    return this.client
  }
  async connect(_config: ExternalAgentConfig) {}
  async disconnect() {}
  async createSession(): Promise<ExternalAgentSession> {
    throw new Error("fixture")
  }
  async closeSession() {}
  async *prompt(): AsyncIterable<ExternalAgentEvent> {}
  async respondToPermission() {}
  async cancel() {}
}
function setup(replies: Record<string, unknown | (() => unknown)> = {}) {
  const request = jest.fn(async (type: string, _params?: unknown) =>
    typeof replies[type] === "function" ? (replies[type] as () => unknown)() : replies[type]
  )
  const client = new OmpSessionClient({
    request: request as OmpRequestDispatch,
    prompt: () => {
      throw new Error("unexpected prompt")
    },
  })
  return { adapter: new TestAdapter(client), request }
}
describe("OMP shared session operations", () => {
  it("qualifies models and preserves slash-containing model names", async () => {
    const { adapter, request } = setup({
      get_state: { model: { provider: "p", id: "a/b", name: "B" } },
      get_available_models: { models: [{ provider: "p", id: "a/b", name: "B" }] },
    })
    expect(await adapter.getSessionModels("s")).toEqual({
      currentModelId: "p/a/b",
      availableModels: [{ modelId: "p/a/b", name: "B" }],
    })
    await adapter.setSessionModel("s", "p/a/b")
    expect(request).toHaveBeenLastCalledWith("set_model", { provider: "p", modelId: "a/b" })
  })
  it("queues images and clears duplicate snapshot messages only after confirmed removal", async () => {
    let pending = ["same", "same"]
    const { adapter, request } = setup({
      get_state: () => ({ queuedMessages: { steering: pending, followUp: [] } }),
      remove_queued_message: () => {
        pending = pending.slice(1)
        return { removed: true }
      },
    })
    await adapter.enqueueSessionInput(
      "s",
      { text: "same", images: [{ data: "one", mimeType: "image/png" }] },
      "steer"
    )
    await adapter.enqueueSessionInput(
      "s",
      { text: "same", images: [{ data: "two", mimeType: "image/png" }] },
      "steer"
    )
    expect(request).toHaveBeenCalledWith("steer", {
      message: "same",
      images: [{ type: "image", data: "one", mimeType: "image/png" }],
    })
    const cleared = await adapter
      .clearSessionInputQueue("s")
      .catch((error) => error as OmpQueueClearError)
    expect(cleared).toBeInstanceOf(OmpQueueClearError)
    expect(cleared).toMatchObject({
      reason: "attachment-provenance-unavailable",
      removed: { steering: [{ text: "same" }, { text: "same" }] },
      remaining: { steering: [], followUp: [] },
    })
    expect(
      cleared.unverifiedAttachments?.steering.map(
        (x: { images?: Array<{ data: string }> }) => x.images?.[0]?.data
      )
    ).toEqual(["one", "two"])
    expect(request.mock.calls.filter((x) => x[0] === "remove_queued_message")).toHaveLength(2)
  })
  it("reports partial clear instead of claiming refusal succeeded", async () => {
    let calls = 0
    const { adapter } = setup({
      get_state: () => ({ queuedMessages: { steering: calls ? ["B"] : ["A", "B"], followUp: [] } }),
      remove_queued_message: () => ({ removed: ++calls === 1 }),
    })
    const error = await adapter.clearSessionInputQueue("s").catch((e) => e as OmpQueueClearError)
    expect(error).toBeInstanceOf(OmpQueueClearError)
    expect(error).toMatchObject({
      removed: { steering: [{ text: "A" }] },
      remaining: { steering: [{ text: "B" }] },
    })
  })
  it("maps runtime state and refuses unsupported control values before any writes", async () => {
    const { adapter, request } = setup({
      get_state: {
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        queuedMessageCount: 3,
      },
    })
    expect(await adapter.getSessionRuntimeState("s")).toMatchObject({
      queuePolicy: { steering: "all" },
      controls: { autoCompaction: true },
      pendingInputCount: 3,
    })
    await expect(
      adapter.setSessionQueuePolicy("s", { steering: "invalid" } as never)
    ).rejects.toThrow()
    expect(request.mock.calls.some((x) => x[0] === "set_steering_mode")).toBe(false)
  })
  it("preserves entry metadata and tree branches", async () => {
    const entry = {
      id: "u",
      parentId: null,
      type: "message",
      timestamp: "2026-10-06T00:00:00Z",
      extra: { raw: true },
      message: {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
      },
    }
    const { adapter } = setup({
      get_entries: { entries: [entry], leafId: "u" },
      get_tree: { tree: [{ entry, children: [] }], leafId: "u" },
    })
    expect((await adapter.getSessionEntries("s"))[0]).toMatchObject({
      id: "u",
      forkAt: { kind: "entry", id: "u", boundary: "through" },
      message: {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { data: "abc" } },
        ],
      },
      metadata: { extra: { raw: true } },
    })
    expect((await adapter.getSessionTree("s")).roots[0].entry.id).toBe("u")
  })
  it("does not execute a shell after cancellation while permission is pending", async () => {
    const { adapter, request } = setup({ get_state: { isSettled: true } })
    let answer!: (value: { requestId: string; granted: boolean }) => void
    let requestId = ""
    const running = adapter.executeSessionShell("s", "touch file", {
      onPermissionRequest: (r) => {
        requestId = r.id
        return new Promise((resolve) => {
          answer = resolve
        })
      },
    })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await adapter.abortSessionShell("s")
    answer({ requestId, granted: true })
    await expect(running).rejects.toThrow("cancelled")
    expect(request.mock.calls.some((call) => call[0] === "bash")).toBe(false)
  })
  it("requires explicit matching permission for shell and forwards only after acceptance", async () => {
    const { adapter, request } = setup({
      get_state: { isSettled: true },
      bash: { output: "ok", exitCode: 0, cancelled: false, truncated: false },
    })
    await expect(
      adapter.executeSessionShell("s", "echo ok", {
        onPermissionRequest: async (r) => ({ requestId: r.id, granted: false }),
      })
    ).rejects.toThrow()
    expect(request.mock.calls.some((x) => x[0] === "bash")).toBe(false)
    expect(
      await adapter.executeSessionShell("s", "echo ok", {
        onPermissionRequest: async (r) => ({ requestId: r.id, granted: true }),
      })
    ).toEqual({ output: "ok", exitCode: 0, cancelled: false, truncated: false })
    expect(request).toHaveBeenLastCalledWith("bash", { command: "echo ok" })
    await expect(
      adapter.executeSessionShell("s", "echo ok", {
        excludeFromContext: true,
        onPermissionRequest: async (r) => ({ requestId: r.id, granted: true }),
      })
    ).rejects.toThrow("excludeFromContext")
    const close = jest.spyOn(adapter, "closeSession")
    expect(await adapter.abortSessionShell("s")).toEqual({ resumeRequired: true })
    expect(close).toHaveBeenCalledWith("s")
  })
})
