import type {
  SessionTimelinePage,
  SessionTurnMessagesPage,
  TranscriptSource as PublicTranscriptSource,
} from "./controller"
import { TranscriptController } from "./controller"
import { transcriptCapabilitiesV1 } from "./source"

function page(overrides: Partial<SessionTimelinePage> = {}): SessionTimelinePage {
  return { items: [], revision: 1, hasMore: false, ...overrides }
}

describe("TranscriptController", () => {
  it("hands capability absence to the legacy owner without downloading history twice", async () => {
    const source: PublicTranscriptSource = {
      capabilities: jest.fn(async () => null),
      timeline: jest.fn(),
      turnMessages: jest.fn(),
    }
    const controller = new TranscriptController("s1", source)

    await controller.loadInitial()

    expect(controller.getSnapshot().mode).toBe("legacy")
    expect(source.timeline).not.toHaveBeenCalled()
  })

  it("loads the newest page and prepends older pages without replacing current items", async () => {
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(
        page({
          items: [
            {
              kind: "system",
              itemKey: "new",
              revision: 1,
              status: "completed",
              message: { id: "new", role: "system", text: "new", createdAt: 2 },
              startedAt: 2,
            },
          ],
          nextCursor: "older",
          hasMore: true,
        })
      )
      .mockResolvedValueOnce(
        page({
          items: [
            {
              kind: "system",
              itemKey: "old",
              revision: 1,
              status: "completed",
              message: { id: "old", role: "system", text: "old", createdAt: 1 },
              startedAt: 1,
            },
          ],
        })
      )
    const controller = new TranscriptController("s1", {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline,
      turnMessages: jest.fn(),
    })

    await controller.loadInitial()
    await controller.loadOlder()

    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["old", "new"])
    expect(timeline).toHaveBeenLastCalledWith({
      sessionId: "s1",
      direction: "backward",
      cursor: "older",
    })
  })

  it("keeps expanded state while an evicted detail is fetched again", async () => {
    const details: SessionTurnMessagesPage = {
      messages: [],
      revision: 1,
      detailRevision: 1,
      total: 0,
      approximateBytes: 10,
      hasMore: false,
    }
    const source: PublicTranscriptSource = {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => page()),
      turnMessages: jest.fn(async () => details),
    }
    const controller = new TranscriptController("s1", source, {
      softBytes: 1,
      hardBytes: 1,
    })

    await controller.expandTurn("turn:u1", 1, 1)
    expect(controller.getSnapshot().expandedTurnKeys.has("turn:u1")).toBe(true)
    expect(controller.getDetail("turn:u1")).toBeUndefined()

    await controller.expandTurn("turn:u1", 1, 1)
    expect(source.turnMessages).toHaveBeenCalledTimes(2)
  })

  it("clears only the current session cache and reloads newest on a stale detail", async () => {
    const source: PublicTranscriptSource = {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => page({ revision: 2 })),
      turnMessages: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "TRANSCRIPT_STALE" })),
    }
    const controller = new TranscriptController("s1", source)

    await expect(controller.expandTurn("turn:u1", 1, 1)).resolves.toBeUndefined()

    expect(source.timeline).toHaveBeenCalledWith({ sessionId: "s1", direction: "backward" })
    expect(controller.getSnapshot()).toMatchObject({ revision: 2, error: null })
  })
})
