import { defaultPrivateChatPolicy, type TriggerPolicy } from "./policy"

describe("TriggerPolicy", () => {
  it("default private-chat policy engages on every message", () => {
    const p = defaultPrivateChatPolicy()
    expect(p.rules.some((r) => r.kind === "private-default")).toBe(true)
    expect(p.storeUnmatchedInDraftMode).toBe(true)
  })

  it("typed policy compiles", () => {
    const p: TriggerPolicy = {
      rules: [{ kind: "self-mention" }, { kind: "slash-command", prefixes: ["/ask"] }],
      blockers: [
        { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 30 },
        { kind: "cooldown-after-bot-reply", secs: 3 },
      ],
      storeUnmatchedInDraftMode: false,
    }
    expect(p.rules).toHaveLength(2)
  })
})
