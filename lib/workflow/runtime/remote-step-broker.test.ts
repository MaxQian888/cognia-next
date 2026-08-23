/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  STEP_EXECUTE_CHANNEL,
  STEP_PENDING_PUSH_CHANNEL,
  RESULT_CHUNK_CHARS,
  chunkRemoteStepResult,
  dispatchRemoteStep,
  resolveRemoteStep,
  __resetRemoteStepBrokerForTesting,
  type RemoteStepRequest,
} from "./remote-step-broker"
import { HOST_DISPATCH_MAX_RESULT_CHARS } from "@/types/placement/host-dispatch"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { enqueueHostDispatch } from "@/lib/db/host-dispatch-queue"
import {
  __resetHostEventPublisherForTests,
  setHostEventPublisher,
} from "@/lib/companion/host-event-publisher"

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

async function waitForRequest(
  frames: Array<{ event: string; payload: unknown }>
): Promise<RemoteStepRequest> {
  for (let index = 0; index < 100; index += 1) {
    const frame = frames.find((candidate) => candidate.event === STEP_EXECUTE_CHANNEL)
    if (frame) return frame.payload as RemoteStepRequest
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return lastRequest(frames)
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

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().hostDispatchQueue.clear()
}, 15_000)

afterEach(() => {
  __resetRemoteStepBrokerForTesting()
  __resetHostEventPublisherForTests()
})

describe("dispatchRemoteStep / resolveRemoteStep", () => {
  it("emits WS frame with params and ids-only push frame", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    const request = await waitForRequest(frames)
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

    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(request.requestId, { ok: true, output: 1 })[0]
    )
    await expect(promise).resolves.toBe(1)
  })

  it("does not claim an older dispatch from another domain", async () => {
    const timestamp = 1_700_000_000_000
    const unrelated = await enqueueHostDispatch({
      id: "schedule-before-mobile",
      accountId: "acct-domain-safe",
      domain: "schedule-handoff",
      targetRef: "local",
      kind: "scheduled-workflow",
      payload: { scheduleId: "schedule-1" },
      idempotencyKey: "schedule-before-mobile",
      now: timestamp - 1,
      expiresAt: timestamp + 60_000,
    })
    const { frames, emit } = makeDeps()

    const promise = dispatchRemoteStep(
      { ...baseInput, stepId: "n_domain_safe" },
      { emit, isTauriFn: () => true, accountId: "acct-domain-safe", now: () => timestamp }
    )
    const request = await waitForRequest(frames)
    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(request.requestId, { ok: true, output: "mobile-result" })[0]
    )

    await expect(promise).resolves.toBe("mobile-result")
    await expect(getDb().hostDispatchQueue.get(unrelated.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
    })
  })

  it("resolves with the device output across multiple chunks", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    const { requestId } = await waitForRequest(frames)
    const bigOutput = { photo: "x".repeat(100_000) }
    const chunks = chunkRemoteStepResult(requestId, { ok: true, output: bigOutput }, 32_768)
    expect(chunks.length).toBeGreaterThan(1)
    // Deliver out of order — reassembly is index-based.
    for (const c of [...chunks].reverse()) {
      const outcome = await resolveRemoteStep("dev-7", c)
      expect(outcome.ok).toBe(true)
    }
    await expect(promise).resolves.toEqual(bigOutput)
  })

  it("turns oversized device output into a bounded terminal error", () => {
    const chunks = chunkRemoteStepResult("oversized", {
      ok: true,
      output: "x".repeat(HOST_DISPATCH_MAX_RESULT_CHARS + 1),
    })
    const result = JSON.parse(chunks.map((chunk) => chunk.chunk).join(""))

    expect(result).toMatchObject({ ok: false, code: "result_too_large" })
    expect(chunks.every((chunk) => chunk.chunk.length <= RESULT_CHUNK_CHARS)).toBe(true)
    expect(() => chunkRemoteStepResult("invalid", { ok: true, output: null }, 0)).toThrow(
      RangeError
    )
  })

  it("rejects when the device reports an error result", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    const { requestId } = await waitForRequest(frames)
    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(requestId, {
        ok: false,
        message: "user cancelled",
        code: "cancelled",
      })[0]
    )
    await expect(promise).rejects.toMatchObject({ code: "cancelled", retryable: false })
  })

  it("defaults missing device codes and classifies retryable device failures", async () => {
    const first = makeDeps()
    const firstPromise = dispatchRemoteStep(baseInput, first.deps)
    const firstRequest = await waitForRequest(first.frames)
    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(firstRequest.requestId, {
        ok: false,
        message: "native failure",
      })[0]
    )
    await expect(firstPromise).rejects.toMatchObject({ code: "device_error", retryable: false })

    const second = makeDeps()
    const secondPromise = dispatchRemoteStep({ ...baseInput, stepId: "n_retry" }, second.deps)
    const secondRequest = await waitForRequest(second.frames)
    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(secondRequest.requestId, {
        ok: false,
        code: "unavailable",
        message: "phone offline",
      })[0]
    )
    await expect(secondPromise).rejects.toMatchObject({ code: "unavailable", retryable: true })
  })

  it("rejects results from a device other than the target", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    const { requestId } = await waitForRequest(frames)
    const chunk = chunkRemoteStepResult(requestId, { ok: true, output: 1 })[0]
    await expect(resolveRemoteStep("dev-EVIL", chunk)).resolves.toEqual({
      ok: false,
      reason: "wrong-device",
    })
    // Legit device can still answer afterwards.
    await expect(resolveRemoteStep("dev-7", chunk)).resolves.toEqual({
      ok: true,
      complete: true,
    })
    await expect(promise).resolves.toBe(1)
  })

  it("reports not-found for unknown request ids", async () => {
    await expect(
      resolveRemoteStep("dev-7", { requestId: "rst_nope", seq: 0, total: 1, chunk: "{}" })
    ).resolves.toEqual({ ok: false, reason: "not-found" })
  })

  it("rejects malformed chunk metadata", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep(baseInput, deps)
    const { requestId } = await waitForRequest(frames)
    await expect(
      resolveRemoteStep("dev-7", { requestId, seq: 5, total: 2, chunk: "x" })
    ).resolves.toEqual({ ok: false, reason: "malformed" })
    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(requestId, { ok: true, output: null })[0]
    )
    await expect(promise).resolves.toBeNull()
  })

  it("rejects a complete payload that is not a RemoteStepResult", async () => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep({ ...baseInput, stepId: "n_malformed" }, deps)
    const { requestId } = await waitForRequest(frames)

    await resolveRemoteStep("dev-7", { requestId, seq: 0, total: 1, chunk: "{}" })

    await expect(promise).rejects.toMatchObject({ code: "malformed", retryable: false })
  })

  it.each([
    ["failed", "failed", false],
    ["deadletter", "dispatch_failed", true],
    ["cancelled", "cancelled", false],
  ] as const)("rejects a terminal %s durable dispatch", async (status, code, retryable) => {
    const { frames, deps } = makeDeps()
    const promise = dispatchRemoteStep({ ...baseInput, stepId: `n_${status}` }, deps)
    const { requestId } = await waitForRequest(frames)

    await getDb().hostDispatchQueue.update(requestId, {
      status,
      lastError: `${status} delivery`,
      ...(status === "deadletter" ? {} : { terminalCode: code }),
    })

    await expect(promise).rejects.toMatchObject({ code, retryable })
  })

  it("times out when the device never answers", async () => {
    const { deps } = makeDeps()
    await expect(dispatchRemoteStep({ ...baseInput, timeoutMs: 50 }, deps)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    })
  })

  it("aborts with the run's signal", async () => {
    const { deps } = makeDeps()
    const ac = new AbortController()
    const promise = dispatchRemoteStep({ ...baseInput, signal: ac.signal }, deps)
    await Promise.resolve()
    ac.abort()
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it("honors a signal that was already aborted before dispatch", async () => {
    const { deps } = makeDeps()
    const ac = new AbortController()
    ac.abort()

    await expect(
      dispatchRemoteStep({ ...baseInput, stepId: "n_preaborted", signal: ac.signal }, deps)
    ).rejects.toMatchObject({ code: "aborted", retryable: false })
  })

  it("fails before delivery when the durable deadline already elapsed", async () => {
    const { emit } = makeDeps()
    const now = jest.fn().mockReturnValueOnce(100).mockReturnValue(200)

    await expect(
      dispatchRemoteStep(
        { ...baseInput, stepId: "n_expired", timeoutMs: 50 },
        { emit, isTauriFn: () => true, now }
      )
    ).rejects.toMatchObject({ code: "timeout", retryable: true })
    expect(emit).not.toHaveBeenCalled()
  })

  it("fails fast off Tauri", async () => {
    await expect(
      dispatchRemoteStep(baseInput, { emit: jest.fn(), isTauriFn: () => false })
    ).rejects.toThrow(/Host event publisher/)
  })

  it("dispatches from a headless brain through the installed Host event publisher", async () => {
    const frames: Array<{ event: string; payload: unknown }> = []
    const unregister = setHostEventPublisher(async (event, payload) => {
      frames.push({ event, payload })
    })

    const promise = dispatchRemoteStep(baseInput, { accountId: "acct-headless" })
    const request = await waitForRequest(frames)
    await resolveRemoteStep(
      "dev-7",
      chunkRemoteStepResult(request.requestId, { ok: true, output: "from-phone" })[0]
    )

    await expect(promise).resolves.toBe("from-phone")
    unregister()
    __resetHostEventPublisherForTests()
  })
})
