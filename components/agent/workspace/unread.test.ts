import { countUnread, firstUnreadId, isUnread } from "./unread"
import { TEAM_MESSAGE_METADATA_KEYS } from "@/lib/agent-team/team-runtime-dispatcher"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

function msg(over: Partial<AgentTeamMessage> = {}): AgentTeamMessage {
  return {
    id: "m1",
    teamId: "t1",
    type: "direct",
    senderId: "tm-1",
    senderName: "Coder",
    content: "hi",
    read: false,
    timestamp: new Date(),
    ...over,
  }
}

const streaming = { [TEAM_MESSAGE_METADATA_KEYS.STREAMING]: true }

describe("isUnread", () => {
  it("counts a settled message that has not been read", () => {
    expect(isUnread(msg())).toBe(true)
  })

  it("does not count a message already marked read", () => {
    expect(isUnread(msg({ read: true }))).toBe(false)
  })

  it("does not count a message that is still streaming", () => {
    // writeProgress re-upserts the placeholder with read:false on every delta,
    // so a live reply would otherwise flip to unread once per token.
    expect(isUnread(msg({ metadata: streaming }))).toBe(false)
  })

  it("counts the same message once the final write drops the streaming flag", () => {
    expect(isUnread(msg({ metadata: { runtime: "claude" } }))).toBe(true)
  })
})

describe("countUnread", () => {
  it("returns 0 without a team id", () => {
    expect(countUnread({ m1: msg() }, null)).toBe(0)
    expect(countUnread({ m1: msg() }, undefined)).toBe(0)
  })

  it("counts only unread messages belonging to the given team", () => {
    const messages: Record<string, AgentTeamMessage> = {
      a: msg({ id: "a" }),
      b: msg({ id: "b" }),
      c: msg({ id: "c", read: true }),
      d: msg({ id: "d", teamId: "other" }),
      e: msg({ id: "e", metadata: streaming }),
    }
    expect(countUnread(messages, "t1")).toBe(2)
    expect(countUnread(messages, "other")).toBe(1)
  })

  it("returns 0 for an empty store", () => {
    expect(countUnread({}, "t1")).toBe(0)
  })
})

describe("firstUnreadId", () => {
  it("returns the first unread id in thread order", () => {
    const thread = [
      msg({ id: "a", read: true }),
      msg({ id: "b", read: true }),
      msg({ id: "c" }),
      msg({ id: "d" }),
    ]
    expect(firstUnreadId(thread)).toBe("c")
  })

  it("skips a streaming tail so the divider does not jump above a live reply", () => {
    const thread = [msg({ id: "a", read: true }), msg({ id: "b", metadata: streaming })]
    expect(firstUnreadId(thread)).toBeUndefined()
  })

  it("returns undefined when everything is read", () => {
    expect(firstUnreadId([msg({ id: "a", read: true })])).toBeUndefined()
    expect(firstUnreadId([])).toBeUndefined()
  })
})
