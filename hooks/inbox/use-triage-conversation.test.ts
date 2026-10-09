/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useActiveConversationStore } from "@/stores/inbox/active-conversation-store"
import { useTriageConversation } from "./use-triage-conversation"

const mockOverride = { conversationKey: "lark:a1:oc", status: "pending" }
jest.mock("@/hooks/connectors/use-conversation-overrides", () => ({
  useConversationOverride: (key: string | undefined) => (key ? mockOverride : undefined),
}))
jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: (id: string | undefined) =>
    id ? { id, displayName: "Support bot", type: "lark" } : undefined,
}))
const mockResolved = jest.fn()
jest.mock("@/hooks/connectors/use-resolved-binding", () => ({
  useResolvedBinding: (binding: unknown) => mockResolved(binding),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  mockResolved.mockReset().mockReturnValue({ trigger: { rules: [], blockers: [] } })
})
afterAll(fixture.dispose)

async function seed() {
  await getDb().sessions.bulkPut([
    {
      id: "s1",
      title: "Customer",
      createdAt: 1,
      updatedAt: 1,
      platformBinding: {
        adapterId: "a1",
        platform: "lark",
        conversationKey: "lark:a1:oc",
        conversationRef: { platform: "lark", adapterId: "a1" },
      },
    },
    { id: "plain", title: "Not IM", createdAt: 1, updatedAt: 1 },
  ] as never)
  await getDb().sessionState.put({ sessionId: "s1", unreadCount: 4, lastReadAt: 0 })
}

describe("useTriageConversation", () => {
  it("is idle without a session id", () => {
    const { result } = renderHook(() => useTriageConversation(null))
    expect(result.current).toEqual({ status: "idle" })
  })

  it("reads the session, override, adapter, policy and unread count", async () => {
    await seed()
    const { result } = renderHook(() => useTriageConversation("s1"))
    expect(result.current.status).toBe("loading")
    await waitFor(() => expect(result.current.status).toBe("ready"))
    if (result.current.status !== "ready") throw new Error("unreachable")
    expect(result.current.conversation).toMatchObject({
      conversationKey: "lark:a1:oc",
      adapterId: "a1",
      platform: "lark",
      override: mockOverride,
      adapter: { displayName: "Support bot" },
      policy: { rules: [], blockers: [] },
    })
    await waitFor(() => {
      if (result.current.status === "ready") expect(result.current.conversation.unreadCount).toBe(4)
    })
    expect(mockResolved).toHaveBeenLastCalledWith({
      adapterId: "a1",
      conversationKey: "lark:a1:oc",
    })
  })

  it("reports a missing or unbound session", async () => {
    await seed()
    const missing = renderHook(() => useTriageConversation("nope"))
    await waitFor(() => expect(missing.result.current.status).toBe("missing"))
    const unbound = renderHook(() => useTriageConversation("plain"))
    await waitFor(() => expect(unbound.result.current.status).toBe("missing"))
  })

  it("never registers the preview as a viewed conversation", async () => {
    // Registering would silence OS notifications and the phone relay for a
    // conversation the user only glanced at, and zero its unread count.
    await seed()
    const { result } = renderHook(() => useTriageConversation("s1"))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const state = useActiveConversationStore.getState()
    expect(state.activeConversationKey).toBeNull()
    expect(state.visiblePanes).toEqual({})
    expect((await getDb().sessionState.get("s1"))?.unreadCount).toBe(4)
  })
})
