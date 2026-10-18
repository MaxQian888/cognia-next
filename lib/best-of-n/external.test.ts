import { runExternalCandidate, type ExternalCandidateDeps } from "./external"

function deps(registered: boolean) {
  const execute = jest.fn(async () => ({ success: true, finalResponse: "done" }))
  const manager = { getAgent: jest.fn(() => (registered ? {} : undefined)), execute }
  const forward = jest.fn()
  const value = {
    manager: jest.fn(async () => manager),
    ensureReady: jest.fn(async () => ({ ok: true, alreadyConnected: false }) as const),
    place: jest.fn(async () => undefined),
    pipe: jest.fn(async () => forward),
  }
  return {
    deps: value as unknown as ExternalCandidateDeps & typeof value,
    manager,
    execute,
    forward,
  }
}
const input = {
  configId: "codex-1",
  prompt: "Fix it",
  model: "gpt-5",
  workingDirectory: "/candidate",
  signal: new AbortController().signal,
  onCapture: jest.fn(),
}

it("launches the recorded configuration in the candidate root through the manager", async () => {
  const f = deps(true)
  expect(await runExternalCandidate(input, f.deps)).toEqual({ text: "done" })
  expect(f.deps.ensureReady).not.toHaveBeenCalled()
  expect(f.deps.place).toHaveBeenCalledWith("codex-1", "/candidate", f.manager)
  expect(f.execute).toHaveBeenCalledWith("codex-1", "Fix it", {
    workingDirectory: "/candidate",
    model: "gpt-5",
    onEvent: f.forward,
    signal: input.signal,
  })
  // No MCP servers, tool ceiling or dollar budget can reach the external CLI.
  expect(f.execute.mock.calls[0]).toHaveLength(3)
})

it("registers an unloaded configuration and refuses one that cannot run", async () => {
  const f = deps(false)
  await runExternalCandidate(input, f.deps)
  expect(f.deps.ensureReady).toHaveBeenCalledWith("codex-1")
  f.deps.ensureReady.mockResolvedValueOnce({ ok: false, reason: "unknown-agent" } as never)
  await expect(runExternalCandidate(input, f.deps)).rejects.toThrow("configuration not found")
  f.deps.ensureReady.mockResolvedValueOnce({
    ok: false,
    reason: "blocked",
    detail: "no CLI",
  } as never)
  await expect(runExternalCandidate(input, f.deps)).rejects.toThrow("no CLI")
  expect(f.execute).toHaveBeenCalledTimes(1)
})

it("turns an unsuccessful run into a failure, and never starts after cancellation", async () => {
  const f = deps(true)
  f.execute.mockResolvedValueOnce({ success: false, error: "boom" } as never)
  await expect(runExternalCandidate(input, f.deps)).rejects.toThrow("boom")
  const aborted = new AbortController()
  aborted.abort()
  await expect(runExternalCandidate({ ...input, signal: aborted.signal }, f.deps)).rejects.toThrow()
  expect(f.execute).toHaveBeenCalledTimes(1)
})

it("reports the agent's token usage, also for a run that failed", async () => {
  const f = deps(true)
  const onUsage = jest.fn()
  const tokenUsage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 }
  f.execute.mockResolvedValueOnce({ success: true, finalResponse: "done", tokenUsage } as never)
  await runExternalCandidate({ ...input, onUsage }, f.deps)
  expect(onUsage).toHaveBeenLastCalledWith(tokenUsage)
  f.execute.mockResolvedValueOnce({ success: false, error: "boom", tokenUsage } as never)
  await expect(runExternalCandidate({ ...input, onUsage }, f.deps)).rejects.toThrow("boom")
  expect(onUsage).toHaveBeenCalledTimes(2)
  // A run that reported nothing books nothing.
  await runExternalCandidate({ ...input, onUsage }, f.deps)
  expect(onUsage).toHaveBeenCalledTimes(2)
})
