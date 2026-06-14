/**
 * Tests for lib/notifications/conversation-notify.ts — the proactive IM helper.
 * The Notification Center runtime is mocked so we assert only the input shape.
 */

const notifyMock = jest.fn(async () => "rec_1")
jest.mock("./runtime", () => ({
  __esModule: true,
  notify: (...args: unknown[]) => notifyMock(...(args as [])),
}))

import { notifyConversationOverIM } from "./conversation-notify"

beforeEach(() => notifyMock.mockClear())

describe("notifyConversationOverIM", () => {
  it("funnels through notify() with center+im channels and a conversation sourceRef", async () => {
    const id = await notifyConversationOverIM({
      conversationKey: "telegram:tg-1:9",
      title: "Done",
      body: "Build finished",
    })
    expect(id).toBe("rec_1")
    const input = notifyMock.mock.calls[0][0] as Record<string, unknown>
    expect(input).toMatchObject({
      source: "connector",
      level: "info",
      title: "Done",
      body: "Build finished",
      channels: ["center", "im"],
      sourceRef: { kind: "conversation", id: "telegram:tg-1:9" },
    })
  })

  it("honors an explicit level + source + dedupeKey + directed", async () => {
    await notifyConversationOverIM({
      conversationKey: "telegram:tg-1:9",
      title: "Need input",
      level: "warning",
      source: "agent-team",
      dedupeKey: "k1",
      directed: true,
    })
    const input = notifyMock.mock.calls[0][0] as Record<string, unknown>
    expect(input).toMatchObject({
      level: "warning",
      source: "agent-team",
      dedupeKey: "k1",
      directed: true,
    })
  })
})
