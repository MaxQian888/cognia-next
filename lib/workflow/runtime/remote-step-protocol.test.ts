import {
  RESULT_CHUNK_CHARS,
  STEP_EXECUTE_CHANNEL,
  STEP_PENDING_PUSH_CHANNEL,
  type RemoteStepRequest,
  type RemoteStepResult,
} from "./remote-step-protocol"

it("pins the mobile remote-step channels and safe result chunk size", () => {
  expect(STEP_EXECUTE_CHANNEL).toBe("workflow://step-execute")
  expect(STEP_PENDING_PUSH_CHANNEL).toBe("workflow://step-pending")
  expect(RESULT_CHUNK_CHARS).toBe(32_768)
})

it("keeps request and result envelopes structurally usable at the protocol boundary", () => {
  const request: RemoteStepRequest = {
    requestId: "request-1",
    targetDeviceId: "device-1",
    kind: "mobile.capture_photo",
    params: { quality: 0.8 },
    runId: "run-1",
    stepId: "step-1",
    workflowId: "workflow-1",
    issuedAt: 100,
    timeoutAt: 200,
  }
  const success: RemoteStepResult = { ok: true, output: { assetId: "asset-1" } }
  const failure: RemoteStepResult = { ok: false, message: "denied", code: "device_error" }

  expect(request.timeoutAt).toBeGreaterThan(request.issuedAt)
  expect(success.ok).toBe(true)
  expect(failure).toMatchObject({ ok: false, code: "device_error" })
})
