import type { SpawnTaskExternalDeps } from "./spawn-task"

const mockIsTauri = jest.fn(() => false)
const mockProxyToRenderer = jest.fn(async (_method: string, _input: unknown) => ({
  ok: true,
  taskSessionId: "task-proxy",
}))
const mockDefaultDispatch = jest.fn(async (_parentSessionId: string, _brief: unknown) => ({
  ok: true,
  taskSessionId: "task-tauri",
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))
jest.mock("@/lib/external-bridge/orchestration-proxy-client", () => ({
  proxyToRenderer: (method: string, input: unknown) => mockProxyToRenderer(method, input),
}))
jest.mock("@cognia/redact", () => ({ hasNoLeakingPiiDeep: () => true }))
jest.mock("@/lib/tasks/spawn-task-dispatch", () => ({
  dispatchSpawnTask: (parentSessionId: string, brief: unknown) =>
    mockDefaultDispatch(parentSessionId, brief),
}))

import { spawnTask, spawnTaskCore } from "./spawn-task"

const input = {
  parentSessionId: "parent-1",
  title: "Fix retry cleanup",
  tldr: "Handle this as a focused task.",
  situation: "The terminal event retains an abort controller.",
  code_locations: ["hooks/chat/use-stream.ts:42"],
  solution: "Clear it when streaming terminates.",
  caveats: ["Keep retry behavior."],
  mode: "aside" as const,
}

function deps(overrides: Partial<SpawnTaskExternalDeps> = {}): SpawnTaskExternalDeps {
  return {
    gate: jest.fn(() => true),
    dispatch: jest.fn(async (_sessionId, brief) => ({
      ok: true,
      taskSessionId: "task-1",
      ...brief,
    })),
    ...overrides,
  }
}

describe("external bridge spawn_task", () => {
  it("proxies browser calls to the renderer", async () => {
    await expect(spawnTask(input)).resolves.toEqual({ ok: true, taskSessionId: "task-proxy" })
    expect(mockProxyToRenderer).toHaveBeenCalledWith("spawn_task", input)
  })

  it("dispatches Tauri calls through the local guarded path", async () => {
    mockIsTauri.mockReturnValueOnce(true)

    await expect(spawnTask(input)).resolves.toEqual({ ok: true, taskSessionId: "task-tauri" })
    expect(mockDefaultDispatch).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ title: input.title })
    )
  })

  it("validates and dispatches a staged sidechat task", async () => {
    const d = deps()
    await expect(spawnTaskCore(input, d)).resolves.toMatchObject({
      ok: true,
      taskSessionId: "task-1",
    })
    expect(d.dispatch).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ title: input.title, mode: "aside" })
    )
  })

  it("blocks PII before dispatch and reports invalid input", async () => {
    const blocked = deps({ gate: jest.fn(() => false) })
    await expect(spawnTaskCore(input, blocked)).resolves.toEqual({
      ok: false,
      error: "spawn_task input failed the outbound PII gate",
    })
    expect(blocked.dispatch).not.toHaveBeenCalled()

    await expect(spawnTaskCore({ ...input, parentSessionId: "" }, deps())).resolves.toEqual({
      ok: false,
      error: "spawn_task requires a parentSessionId",
    })
  })

  it("reports schema and dispatch failures without leaking exceptions", async () => {
    await expect(spawnTaskCore({ ...input, title: "" }, deps())).resolves.toMatchObject({
      ok: false,
      error: expect.any(String),
    })

    await expect(
      spawnTaskCore(
        input,
        deps({
          dispatch: jest.fn(async () => {
            throw new Error("dispatch failed")
          }),
        })
      )
    ).resolves.toEqual({ ok: false, error: "dispatch failed" })

    await expect(
      spawnTaskCore(
        input,
        deps({
          dispatch: jest.fn(async () => {
            throw "non-error failure"
          }),
        })
      )
    ).resolves.toEqual({ ok: false, error: "non-error failure" })
  })
})
