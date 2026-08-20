import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { ExecutionRun, ExecutionRunBinding } from "@/types/execution/run"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import {
  LarkFollowUpControlDispatchError,
  maybeHandleLarkFollowUpControl,
  maybeHandleRunControlFollowUp,
} from "./follow-up-control"

const event = (text: string): NormalizedInboundEvent => ({
  platform: "lark",
  adapterId: "lark-1",
  selfId: "bot-1",
  messageId: "om-click",
  conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "chat-1" },
  conversationKey: "lark:lark-1:chat-1",
  sender: {
    id: "identity-user",
    platform: "lark",
    adapterId: "lark-1",
    remoteUserId: "ou-user",
    displayName: "User",
  },
  channel: { id: "chat-1", kind: "private" },
  segments: [{ type: "text", text }],
  plainText: text,
  mentions: { selfMentioned: false, users: [] },
  timestamp: 500,
  raw: {},
})

const binding = {
  id: "binding-1",
  runId: "run-1",
  adapterId: "lark-1",
  conversationKey: "lark:lark-1:chat-1",
  status: "active",
  deliveryMode: "native",
  platformMessageId: "om-progress",
  presentationState: {
    followUpControl: {
      platformMessageId: "om-progress",
      runId: "run-1",
      revision: 1,
      createdAt: 100,
      expiresAt: 700,
      items: [
        { action: "stop", content: "Stop", localizedContent: "停止" },
        { action: "status", content: "View status", localizedContent: "查看状态" },
      ],
    },
  },
  lastProjectedRevision: 1,
  createdAt: 100,
  updatedAt: 200,
} as ExecutionRunBinding

const run = {
  id: "run-1",
  kind: "agent-turn",
  sourceId: "source-1",
  title: "Agent run",
  status: "running",
  initiator: { platformIdentityId: "identity-user", remoteUserId: "ou-user" },
  currentRevision: 4,
  latestSnapshot: {
    runId: "run-1",
    kind: "agent-turn",
    title: "Agent run",
    status: "running",
    revision: 4,
    startedAt: 1,
    updatedAt: 400,
    progress: { completed: 1, total: 2, trustworthy: true },
    activeSteps: [],
    recentSteps: [],
    pendingSteps: [],
    pendingStepCount: 1,
    elapsedMs: 399,
    artifacts: [],
    allowedActions: ["stop"],
  },
  startedAt: 1,
  updatedAt: 400,
} as ExecutionRun

// Only the two fields the follow-up control path reads; the row has a dozen
// more that this test has no opinion about.
const adapter = {
  id: "lark-1",
  settings: { runOperatorUserIds: ["ou-operator"] },
} as unknown as AdapterInstanceRow

describe("Lark follow-up controls", () => {
  it("authorizes a clicked localized control against the latest run revision", async () => {
    const execute = jest.fn(async () => ({ accepted: true }))
    const consume = jest.fn(async () => undefined)
    const handled = await maybeHandleLarkFollowUpControl(event("停止"), adapter, {
      now: () => 500,
      listBindings: async () => [binding],
      getRun: async () => run,
      execute,
      consume,
      enqueue: jest.fn(),
    })

    expect(handled).toBe(true)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        action: "stop",
        expectedRevision: 4,
        actor: expect.objectContaining({ remoteUserId: "ou-user" }),
      }),
      { operatorIds: ["ou-operator"] }
    )
    expect(consume).toHaveBeenCalledWith(binding, 500)
  })

  it("renders status without invoking a state-changing control", async () => {
    const enqueue = jest.fn(async () => undefined as unknown as OutboundJobRow)
    const execute = jest.fn()
    const handled = await maybeHandleLarkFollowUpControl(event("View status"), adapter, {
      now: () => 500,
      listBindings: async () => [binding],
      getRun: async () => run,
      execute,
      consume: jest.fn(async () => undefined),
      enqueue,
    })

    expect(handled).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "lark:lark-1:chat-1",
        request: expect.objectContaining({
          segments: [
            expect.objectContaining({ type: "text", text: expect.stringContaining("running") }),
          ],
        }),
      })
    )
  })

  it("ignores expired registrations and every group/topic message", async () => {
    const deps = {
      now: () => 800,
      listBindings: jest.fn(async () => [binding]),
      getRun: jest.fn(async () => run),
      execute: jest.fn(),
      consume: jest.fn(async () => undefined),
      enqueue: jest.fn(),
    }
    await expect(maybeHandleLarkFollowUpControl(event("Stop"), adapter, deps)).resolves.toBe(false)
    await expect(
      maybeHandleLarkFollowUpControl(
        { ...event("Stop"), channel: { id: "chat-1", kind: "thread" } },
        adapter,
        { ...deps, now: () => 500 }
      )
    ).resolves.toBe(false)
  })

  it("marks a matched control failure so the bus never routes its label as an AI prompt", async () => {
    await expect(
      maybeHandleLarkFollowUpControl(event("Stop"), adapter, {
        now: () => 500,
        listBindings: async () => [binding],
        getRun: async () => run,
        execute: jest.fn(),
        consume: async () => {
          throw new Error("storage unavailable")
        },
        enqueue: jest.fn(),
      })
    ).rejects.toBeInstanceOf(LarkFollowUpControlDispatchError)
  })
})

describe("run control is not a one-platform feature", () => {
  // Everything below the old `event.platform !== "lark"` gate was already
  // platform-neutral: bindings are read by conversationKey, the match is
  // against the durable registration, and authorization goes through the
  // shared execution-control gate. The gate meant eleven of twelve platforms
  // had no way to stop a delegated run from the thread showing it.
  const onPlatform = (platform: string, text: string): NormalizedInboundEvent => ({
    ...event(text),
    platform: platform as NormalizedInboundEvent["platform"],
  })

  it.each(["telegram", "discord", "matrix", "wecom", "onebot"])(
    "accepts a typed control on %s",
    async (platform) => {
      const execute = jest.fn(async () => ({ accepted: true }))
      const handled = await maybeHandleRunControlFollowUp(onPlatform(platform, "Stop"), adapter, {
        now: () => 500,
        listBindings: async () => [binding],
        getRun: async () => run,
        execute,
        consume: jest.fn(async () => undefined),
        enqueue: jest.fn(),
      })

      expect(handled).toBe(true)
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", action: "stop" }),
        { operatorIds: ["ou-operator"] }
      )
    }
  )

  it("still ignores group messages on every platform", async () => {
    // A bare "stop" is a plausible thing to say in a group for reasons that
    // have nothing to do with a run, and the match is by exact label. Groups
    // keep the card buttons, which carry an explicit action id.
    const execute = jest.fn(async () => ({ accepted: true }))
    const handled = await maybeHandleRunControlFollowUp(
      { ...onPlatform("discord", "Stop"), channel: { id: "chat-1", kind: "group" } },
      adapter,
      {
        now: () => 500,
        listBindings: async () => [binding],
        getRun: async () => run,
        execute,
        consume: jest.fn(async () => undefined),
        enqueue: jest.fn(),
      }
    )
    expect(handled).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it("keeps the old name working while the rename settles", () => {
    expect(maybeHandleLarkFollowUpControl).toBe(maybeHandleRunControlFollowUp)
  })
})
