import { useSideChatRequestStore } from "./side-chat-request-store"

beforeEach(() => useSideChatRequestStore.setState({ pending: {} }))

it("retains separate requests while unmounted and claims each exactly once", () => {
  const store = useSideChatRequestStore.getState()
  store.enqueue("aside-a", "first")
  store.enqueue("aside-a", "second")
  store.enqueue("aside-b", "other")
  const requests = useSideChatRequestStore.getState().pending["aside-a"]
  expect(requests.map((r) => r.question)).toEqual(["first", "second"])
  expect(store.claim("aside-b", requests[0].id)).toBeNull()
  expect(store.claim("aside-a", requests[0].id)?.question).toBe("first")
  expect(store.claim("aside-a", requests[0].id)).toBeNull()
  expect(useSideChatRequestStore.getState().pending["aside-a"]).toEqual([requests[1]])
  expect(useSideChatRequestStore.getState().pending["aside-b"]).toHaveLength(1)
})
