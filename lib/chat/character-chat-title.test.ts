import { characterChatTitle, type ChatTitleTranslator } from "./character-chat-title"

function translator(has: boolean): ChatTitleTranslator {
  const t = ((key: "chatTitle", values: { name: string }) =>
    has ? `Chat with ${values.name}` : `desktop.memberList.${key}`) as ChatTitleTranslator
  t.has = () => has
  return t
}

describe("characterChatTitle", () => {
  it("uses the translated title when the message is present", () => {
    expect(characterChatTitle(translator(true), "Brainstorm Buddy")).toBe(
      "Chat with Brainstorm Buddy"
    )
  })

  it("falls back to the character name rather than persisting the message key", () => {
    // The regression: a shell whose message bundle predates the key wrote
    // `desktop.memberList.chatTitle` into the session title.
    expect(characterChatTitle(translator(false), "Brainstorm Buddy")).toBe("Brainstorm Buddy")
  })
})
