/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getWorkSubmission } from "@/lib/db/work-submissions"

import { acceptWorkSubmission, bindWorkExecutionContext } from "./service"
import { createStoredChatDispatch } from "./stored-chat-dispatch"

const mockSendPrompt = jest.fn(async (..._args: unknown[]) => undefined)

jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...args: unknown[]) => mockSendPrompt(...args),
}))
const mockAbortRouterFusionSend = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/router-fusion/gate/chat-send", () => ({
  ...jest.requireActual("@/lib/router-fusion/gate/chat-send"),
  abortRouterFusionSend: (...args: unknown[]) => mockAbortRouterFusionSend(...args),
}))

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const NOW = 1_755_000_000_000
const KEY = new Uint8Array(32).fill(19)
const loadKey = async () => KEY

async function seedReplayableSubmission(
  sendOptions: Record<string, unknown> = { cwd: "/original/workspace", model: "claude-sonnet-4-5" }
) {
  await acceptWorkSubmission(
    {
      intent: {
        contractVersion: 1,
        idempotencyKey: "chat:session-1:message-1",
        source: { kind: "chat", sourceId: "session-1" },
        scope: {
          accountId: "account-1",
          runtimeTargetId: "target-1",
          sessionId: "session-1",
        },
        availabilityPolicy: "wait",
      },
      runId: "run-1",
      turnId: "turn-1",
      inputBatchId: "batch-1",
      submissionId: "submission-1",
      input: { content: "frozen prompt", visibleMessageIds: ["message-1"], attachments: [] },
      now: NOW,
    },
    { loadKey }
  )
  await bindWorkExecutionContext(
    {
      submissionId: "submission-1",
      accountId: "account-1",
      contextBundleId: "context-1",
      context: {
        cwd: "/original/workspace",
        projectId: "project-1",
        sendOptions,
      },
      now: NOW,
    },
    { loadKey }
  )
  return (await getWorkSubmission("submission-1"))!
}

describe("stored chat dispatch", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    mockSendPrompt.mockReset().mockResolvedValue(undefined)
    mockAbortRouterFusionSend.mockClear()
  }, 30_000)

  it("replays the frozen prompt and send options through the canonical send path", async () => {
    const row = await seedReplayableSubmission()
    const prepare = jest.fn()

    const outcome = await createStoredChatDispatch({ loadKey, prepareRouterFusionSend: prepare })(
      row
    )
    // [ACC:OFF-02] an unstamped replay never enters Router + Fusion.
    expect(prepare).not.toHaveBeenCalled()

    expect(outcome).toEqual({ status: "dispatched" })
    expect(mockSendPrompt).toHaveBeenCalledWith(
      "session-1",
      "frozen prompt",
      { cwd: "/original/workspace", model: "claude-sonnet-4-5" },
      { commandId: "submission-1" }
    )
  }, 30_000)

  describe("a turn accepted under Router + Fusion (ADR-0188)", () => {
    const stamped = {
      cwd: "/original/workspace",
      provider: "openai",
      model: "gpt-5",
      routerFusion: { runId: "rf-old", providerId: "openai", modelId: "gpt-5" },
      ledger: {
        runId: "rf-old",
        mode: "per_call",
        transportAttempts: 2,
        deploymentId: "openai::gpt-5",
      },
    }

    it("replays on the same deployment as a new run", async () => {
      const row = await seedReplayableSubmission(stamped)
      const replayed = { ...stamped, routerFusion: { ...stamped.routerFusion, runId: "rf-new" } }
      const prepare = jest.fn().mockResolvedValue({ kind: "send", options: replayed })

      await expect(
        createStoredChatDispatch({ loadKey, prepareRouterFusionSend: prepare })(row)
      ).resolves.toEqual({
        status: "dispatched",
      })
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          reused: true,
          workspaceId: "project-1",
          options: expect.objectContaining({ routerFusion: stamped.routerFusion }),
        })
      )
      expect(mockSendPrompt).toHaveBeenCalledWith("session-1", "frozen prompt", replayed, {
        commandId: "submission-1",
      })
    }, 30_000)

    it("[ACC:ISO-04] fails a replay Router + Fusion refuses instead of sending it", async () => {
      const row = await seedReplayableSubmission(stamped)
      const prepare = jest.fn().mockResolvedValue({ kind: "refused", code: "PROVIDER_UNAVAILABLE" })

      await expect(
        createStoredChatDispatch({ loadKey, prepareRouterFusionSend: prepare })(row)
      ).resolves.toEqual({
        status: "failed",
        errorCode: "router_fusion_refused:PROVIDER_UNAVAILABLE",
      })
      expect(mockSendPrompt).not.toHaveBeenCalled()
    }, 30_000)

    it("releases the new run when the replay could not be handed to the host", async () => {
      const row = await seedReplayableSubmission(stamped)
      const replayed = { ...stamped, routerFusion: { ...stamped.routerFusion, runId: "rf-new" } }
      const prepare = jest.fn().mockResolvedValue({ kind: "send", options: replayed })
      mockSendPrompt.mockRejectedValueOnce(new Error("host away"))

      await expect(
        createStoredChatDispatch({ loadKey, prepareRouterFusionSend: prepare })(row)
      ).rejects.toThrow("host away")
      expect(mockAbortRouterFusionSend).toHaveBeenCalledWith("session-1", replayed, "host away")
    }, 30_000)
  })

  it("parks an accepted turn whose frozen dispatch context was never committed", async () => {
    const row = await seedReplayableSubmission()
    await getDb().executionContextBundles.delete("context-1")

    await expect(createStoredChatDispatch({ loadKey })(row)).resolves.toEqual({
      status: "recovery_required",
      errorCode: "missing_frozen_context",
    })
    expect(mockSendPrompt).not.toHaveBeenCalled()
  }, 30_000)

  it("parks a payload whose recorded digest no longer proves byte-identical replay", async () => {
    const row = await seedReplayableSubmission()
    await getDb().workInputBatches.update("batch-1", { digest: "tampered" })

    await expect(createStoredChatDispatch({ loadKey })(row)).resolves.toEqual({
      status: "recovery_required",
      errorCode: "frozen_input_digest_mismatch",
    })
    expect(mockSendPrompt).not.toHaveBeenCalled()
  }, 30_000)
})
