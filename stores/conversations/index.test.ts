import { useConversationManagerStore } from "./index"
import { useConversationManagerStore as direct } from "./conversation-manager-store"

test("re-exports the conversation manager store", () => {
  expect(useConversationManagerStore).toBe(direct)
})
