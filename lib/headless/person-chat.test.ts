import { initializePersonChat, personChatCapability } from "./person-chat"

afterEach(() => initializePersonChat("brain", {}))

it("enables only a person brain with the exact Host flag, captured at startup", () => {
  const env = { COGNIA_PERSON_CHAT: "tool-less" }
  initializePersonChat("person-brain", env)
  env.COGNIA_PERSON_CHAT = "none"
  expect(personChatCapability()).toEqual({ chat: "tool-less" })
  initializePersonChat("brain", { COGNIA_PERSON_CHAT: "tool-less" })
  expect(personChatCapability()).toEqual({ chat: "none" })
  initializePersonChat("person-brain", {})
  expect(personChatCapability()).toEqual({ chat: "none" })
})
