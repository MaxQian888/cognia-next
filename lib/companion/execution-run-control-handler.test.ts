import {
  UPGRADE_REQUIRED_RESULT,
  handleExecutionRunControl,
  handleLegacyTeamRunControl,
  parseExecutionRunControlPayload,
} from "./execution-run-control-handler"
import type { RunControlResult } from "@/lib/execution/run-control"

const base = {
  runId: "execution:team:run_1",
  action: "pause",
  idempotencyKey: "phone:1",
  expectedRevision: 4,
}

describe("parseExecutionRunControlPayload", () => {
  it("builds the cockpit's command shape from a remote payload", () => {
    const parsed = parseExecutionRunControlPayload({
      ...base,
      deviceId: "dev-9",
      deviceName: "Pixel",
      interruptId: "int-1",
      steerMessage: "focus on tests",
    })
    expect(parsed).toEqual({
      ok: true,
      command: {
        runId: "execution:team:run_1",
        action: "pause",
        idempotencyKey: "phone:1",
        expectedRevision: 4,
        actor: { remoteUserId: "dev-9", displayName: "Pixel" },
        interruptId: "int-1",
        steerMessage: "focus on tests",
      },
    })
  })

  it.each([
    ["runId", { ...base, runId: "" }],
    ["action", { ...base, action: "explode" }],
    ["idempotencyKey", { ...base, idempotencyKey: undefined }],
    ["expectedRevision", { ...base, expectedRevision: "4" }],
    ["reviewDecision", { ...base, reviewDecision: { kind: "budget_extension", extraTokens: -1 } }],
  ])("rejects a payload with a bad %s", (field, payload) => {
    expect(parseExecutionRunControlPayload(payload as Record<string, unknown>)).toEqual({
      ok: false,
      reason: "invalid-payload",
      field,
    })
  })

  it("carries a well-formed review decision through untouched", () => {
    const parsed = parseExecutionRunControlPayload({
      ...base,
      action: "approve",
      interruptId: "int-2",
      reviewDecision: { kind: "team_recovery", choice: "retry_host", hostRef: "host-b" },
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.command.reviewDecision).toEqual({
        kind: "team_recovery",
        choice: "retry_host",
        hostRef: "host-b",
      })
    }
  })
})

describe("handleExecutionRunControl", () => {
  it("submits through the run control gate with the caller as an operator", async () => {
    const execute = jest.fn(
      async (): Promise<RunControlResult> => ({ accepted: true, revision: 5 }) as RunControlResult
    )
    const result = await handleExecutionRunControl(
      { ...base, deviceId: "dev-9" },
      { execute, operatorIds: () => ["cognia:local-console"] }
    )
    expect(result).toEqual({ accepted: true, revision: 5 })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ runId: base.runId, action: "pause", expectedRevision: 4 }),
      { operatorIds: ["cognia:local-console", "dev-9"] }
    )
  })

  it("returns the gate's refusal as is", async () => {
    const execute = jest.fn(
      async (): Promise<RunControlResult> =>
        ({ accepted: false, reason: "revision_conflict", revision: 6 }) as RunControlResult
    )
    const result = await handleExecutionRunControl(base, { execute })
    expect(result).toMatchObject({ accepted: false, reason: "revision_conflict" })
  })

  it("does not reach the gate for an invalid payload", async () => {
    const execute = jest.fn()
    const result = await handleExecutionRunControl({ ...base, action: "nope" }, { execute })
    expect(result).toEqual({ ok: false, reason: "invalid-payload", field: "action" })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe("handleLegacyTeamRunControl", () => {
  it("tells an older client to upgrade instead of controlling a team", async () => {
    expect(await handleLegacyTeamRunControl()).toEqual(UPGRADE_REQUIRED_RESULT)
    expect(UPGRADE_REQUIRED_RESULT).toEqual({ ok: false, reason: "upgrade-required" })
  })
})
