import { initializePersonChat, personChatCapability } from "./person-chat"

afterEach(() => initializePersonChat("brain", {}))

it("enables only a person brain with the exact Host flag, captured at startup", () => {
  const env = { COGNIA_PERSON_CHAT: "tool-less" }
  initializePersonChat("person-brain", env)
  env.COGNIA_PERSON_CHAT = "none"
  expect(personChatCapability()).toEqual({ chat: "tool-less", execution: "none" })
  initializePersonChat("brain", { COGNIA_PERSON_CHAT: "tool-less" })
  expect(personChatCapability()).toEqual({ chat: "none", execution: "none" })
  initializePersonChat("person-brain", {})
  expect(personChatCapability()).toEqual({ chat: "none", execution: "none" })
})

it("p6e reads sandboxed execution only from a person brain with the exact Host value", () => {
  initializePersonChat("person-brain", { COGNIA_PERSON_EXECUTION: "sandboxed" })
  expect(personChatCapability()).toEqual({ chat: "none", execution: "sandboxed" })
  initializePersonChat("person-brain", {
    COGNIA_PERSON_CHAT: "tool-less",
    COGNIA_PERSON_EXECUTION: "sandboxed",
  })
  expect(personChatCapability()).toEqual({ chat: "tool-less", execution: "sandboxed" })
  initializePersonChat("brain", { COGNIA_PERSON_EXECUTION: "sandboxed" })
  expect(personChatCapability().execution).toBe("none")
  initializePersonChat("person-brain", { COGNIA_PERSON_EXECUTION: "yes" })
  expect(personChatCapability().execution).toBe("none")
})
