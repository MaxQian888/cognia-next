import { parseSlackExport } from "./slack"

describe("parseSlackExport", () => {
  it("returns no sources for an empty array", () => {
    expect(parseSlackExport("[]", { twinId: "t1" })).toEqual([])
  })

  it("formats a flat array of messages into a markdown transcript", () => {
    const json = JSON.stringify([
      { type: "message", user: "U1", text: "hello", ts: "1700000000.000100" },
      { type: "message", user: "U2", text: "hi back", ts: "1700000060.000100" },
    ])
    const sources = parseSlackExport(json, {
      twinId: "twin_alice",
      userMap: { U1: "Alice", U2: "Bob" },
    })
    expect(sources).toHaveLength(1)
    expect(sources[0].format).toBe("markdown")
    expect(sources[0].text).toContain("**Alice**")
    expect(sources[0].text).toContain("**Bob**")
    expect(sources[0].text).toContain("hello")
    expect(sources[0].text).toContain("hi back")
    expect(sources[0].baseMetadata?.speakers?.sort()).toEqual(["Alice", "Bob"])
  })

  it("indents threaded replies under their parent message", () => {
    const json = JSON.stringify([
      {
        type: "message",
        user: "U1",
        text: "Parent",
        ts: "1700000000.000100",
      },
      {
        type: "message",
        user: "U2",
        text: "Reply",
        ts: "1700000020.000100",
        thread_ts: "1700000000.000100",
      },
    ])
    const [source] = parseSlackExport(json, {
      twinId: "twin_alice",
      userMap: { U1: "Alice", U2: "Bob" },
    })
    expect(source.text).toMatch(/Parent[\s\S]*    - \*\*Bob\*\*[\s\S]*Reply/)
  })

  it("accepts envelope shape with messages + users + channel", () => {
    const json = JSON.stringify({
      channel: "engineering",
      users: { U1: { real_name: "Alice Liddell" } },
      messages: [{ type: "message", user: "U1", text: "hello" }],
    })
    const [source] = parseSlackExport(json, { twinId: "twin_alice" })
    expect(source.text).toContain("# Slack — engineering")
    expect(source.text).toContain("**Alice Liddell**")
  })

  it("falls back to <@USER> when no profile is available", () => {
    const json = JSON.stringify([{ type: "message", user: "U_unknown", text: "ghost message" }])
    const [source] = parseSlackExport(json, { twinId: "twin_alice" })
    expect(source.text).toContain("**<@U_unknown>**")
  })

  it("ignores non-message entries", () => {
    const json = JSON.stringify([
      { type: "channel_join", user: "U1", ts: "1" },
      { type: "message", subtype: "bot_message", text: "Bot intro", ts: "2" },
      { type: "message", user: "U1", text: "Real message", ts: "3" },
    ])
    const [source] = parseSlackExport(json, { twinId: "twin_alice", userMap: { U1: "Alice" } })
    expect(source.text).toContain("Real message")
    expect(source.text).toContain("Bot intro") // bot_message subtype still has type:"message"
    expect(source.text).not.toContain("channel_join")
  })

  it("returns no source when every message is filtered out", () => {
    const json = JSON.stringify([{ type: "channel_join", user: "U1" }])
    expect(parseSlackExport(json, { twinId: "t1" })).toEqual([])
  })

  it("returns no source for non-JSON input", () => {
    // JSON.parse throws — caller is responsible for catching, but the
    // behaviour is documented via this test.
    expect(() => parseSlackExport("not json", { twinId: "t1" })).toThrow()
  })
})
