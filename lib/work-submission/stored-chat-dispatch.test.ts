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

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const NOW = 1_755_000_000_000
const KEY = new Uint8Array(32).fill(19)
const loadKey = async () => KEY

async function seedReplayableSubmission() {
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
        sendOptions: { cwd: "/original/workspace", model: "claude-sonnet-4-5" },
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
    mockSendPrompt.mockClear()
  }, 30_000)

  it("replays the frozen prompt and send options through the canonical send path", async () => {
    const row = await seedReplayableSubmission()

    const outcome = await createStoredChatDispatch({ loadKey })(row)

    expect(outcome).toEqual({ status: "dispatched" })
    expect(mockSendPrompt).toHaveBeenCalledWith(
      "session-1",
      "frozen prompt",
      { cwd: "/original/workspace", model: "claude-sonnet-4-5" },
      { commandId: "submission-1" }
    )
  }, 30_000)

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
