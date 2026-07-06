import {
  STEP_EXECUTE_CHANNEL,
  STEP_PENDING_PUSH_CHANNEL,
  chunkRemoteStepResult,
  dispatchRemoteStep,
  resolveRemoteStep,
  __resetRemoteStepBrokerForTesting,
  type RemoteStepRequest,
} from "./remote-step-broker"

function makeDeps() {
  const frames: Array<{ event: string; payload: unknown }> = []
  const emit = jest.fn(async (event: string, payload: unknown) => {
    frames.push({ event, payload })
  })
  return { emit, frames, deps: { emit, isTauriFn: () => true } }
}

function lastRequest(frames: Array<{ event: string; payload: unknown }>): RemoteStepRequest {
  const frame = frames.find((f) => f.event === STEP_EXECUTE_CHANNEL)
  if (!frame) throw new Error("no step-execute frame emitted")
  return frame.payload as RemoteStepRequest
}

const baseInput = {
  targetDeviceId: "dev-7",
  kind: "action.mobile.location",
  params: { enableHighAccuracy: true },
  runId: "run_1",
  stepId: "n_loc",
  workflowId: "wf_1",
  timeoutMs: 5_000,
}

afterEach(() => __resetRemoteStepBrokerForTesting())

describe("dispatchRemoteStep / resolveRemoteStep", () => {
  it("emits WS frame with params and ids-only push frame", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    await Promise.resolve()
    const request = lastRequest(frames)
    expect(request).toMatchObject({
      targetDeviceId: "dev-7",
      kind: "action.mobile.location",
      params: { enableHighAccuracy: true },
    })
    const push = frames.find((f) => f.event === STEP_PENDING_PUSH_CHANNEL)
    expect(push?.payload).toEqual({
      requestId: request.requestId,
      runId: "run_1",
      workflowId: "wf_1",
      targetDeviceId: "dev-7",
    })
    expect(JSON.stringify(push?.payload)).not.toContain("enableHighAccuracy")

    resolveRemoteStep("dev-7", chunkRemoteStepResult(request.requestId, { ok: true, output: 1 })[0])
    await expect(promise).resolves.toBe(1)
  })

  it("resolves with the device output across multiple chunks", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    await Promise.resolve()
    const { requestId } = lastRequest(frames)
    const bigOutput = { photo: "x".repeat(100_000) }
    const chunks = chunkRemoteStepResult(requestId, { ok: true, output: bigOutput }, 32_768)
    expect(chunks.length).toBeGreaterThan(1)
    // Deliver out of order — reassembly is index-based.
    for (const c of [...chunks].reverse()) {
      const outcome = resolveRemoteStep("dev-7", c)
      expect(outcome.ok).toBe(true)
    }
    await expect(promise).resolves.toEqual(bigOutput)
  })

  it("rejects when the device reports an error result", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    await Promise.resolve()
    const { requestId } = lastRequest(frames)
    resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(requestId, {
        ok: false,
        message: "user cancelled",
        code: "cancelled",
      })[0]
    )
    await expect(promise).rejects.toThrow(/user cancelled.*cancelled/)
  })

  it("rejects results from a device other than the target", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    await Promise.resolve()
    const { requestId } = lastRequest(frames)
    const chunk = chunkRemoteStepResult(requestId, { ok: true, output: 1 })[0]
    expect(resolveRemoteStep("dev-EVIL", chunk)).toEqual({ ok: false, reason: "wrong-device" })
    // Legit device can still answer afterwards.
    expect(resolveRemoteStep("dev-7", chunk)).toEqual({ ok: true, complete: true })
    await expect(promise).resolves.toBe(1)
  })

  it("reports not-found for unknown request ids", () => {
    expect(
      resolveRemoteStep("dev-7", { requestId: "rst_nope", seq: 0, total: 1, chunk: "{}" })
    ).toEqual({ ok: false, reason: "not-found" })
  })

  it("rejects malformed chunk metadata", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    await Promise.resolve()
    const { requestId } = lastRequest(frames)
    expect(resolveRemoteStep("dev-7", { requestId, seq: 5, total: 2, chunk: "x" })).toEqual({
      ok: false,
      reason: "malformed",
    })
    resolveRemoteStep("dev-7", chunkRemoteStepResult(requestId, { ok: true, output: null })[0])
    await expect(promise).resolves.toBeNull()
  })

  it("times out when the device never answers", async () => {
    const { deps } = makeDeps()
    await expect(dispatchRemoteStep({ ...baseInput, timeoutMs: 50 }, deps)).rejects.toThrow(
      /timed out after 50ms/
    )
  })

  it("aborts with the run's signal", async () => {
    const { deps } = makeDeps()
    const ac = new AbortController()
    const promise = dispatchRemoteStep({ ...baseInput, signal: ac.signal }, deps)
    await Promise.resolve()
    ac.abort()
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it("fails fast off Tauri", async () => {
    await expect(
      dispatchRemoteStep(baseInput, { emit: jest.fn(), isTauriFn: () => false })
    ).rejects.toThrow(/desktop companion server/)
  })
})
