import { sha256Hex } from "@cognia/agent"

import { OUTBOUND_TOOL_IDS } from "@/lib/policy/risk/outbound-tools"

import {
  conversationTarget,
  extractOutboundTargets,
  mailTarget,
  outboundFingerprint,
  personTarget,
  publicTarget,
  toReviewTarget,
} from "./outbound-targets"

const GROUP = "lark:bot-a:oc_123"

describe("conversationTarget", () => {
  it("names the chat and its adapter", () => {
    expect(conversationTarget(GROUP)).toEqual({
      kind: "conversation",
      channel: "bot-a",
      recipient: "conv:lark:bot-a:oc_123",
    })
  })

  it("drops the thread id so every thread of a chat is one recipient", () => {
    expect(conversationTarget(`${GROUP}:om_thread`)).toEqual(conversationTarget(GROUP))
  })

  it("keeps a Matrix room id that contains the separator", () => {
    expect(conversationTarget("matrix:bot-m:!room:example.org")?.recipient).toBe(
      "conv:matrix:bot-m:!room:example.org"
    )
    expect(conversationTarget("matrix:bot-m:!room:example.org:$event")?.recipient).toBe(
      "conv:matrix:bot-m:!room:example.org"
    )
  })

  it("rejects a malformed key", () => {
    expect(conversationTarget("lark:bot-a")).toBeUndefined()
    expect(conversationTarget("")).toBeUndefined()
    expect(conversationTarget("lark::oc_1")).toBeUndefined()
  })
})

describe("personTarget", () => {
  it("scopes the member to the bot", () => {
    expect(personTarget("bot-a", " ou_1 ")).toEqual({
      kind: "person",
      channel: "bot-a",
      recipient: "person:bot-a:ou_1",
    })
    expect(personTarget("bot-a", "ou_1")).not.toEqual(personTarget("bot-b", "ou_1"))
  })

  it("rejects an empty adapter or member", () => {
    expect(personTarget("", "ou_1")).toBeUndefined()
    expect(personTarget("bot-a", "  ")).toBeUndefined()
  })
})

describe("mailTarget", () => {
  it("lowercases and strips a display name", () => {
    expect(mailTarget("Ada Lovelace <Ada@Example.COM>")).toEqual({
      kind: "mail",
      channel: "mail",
      recipient: "mail:ada@example.com",
    })
    expect(mailTarget(" ada@example.com ")).toEqual(mailTarget("ADA@example.com"))
  })

  it("rejects what is not one address", () => {
    for (const bad of ["ada", "@example.com", "ada@", "a@b@c", "ada smith@example.com", ""]) {
      expect(mailTarget(bad)).toBeUndefined()
    }
  })
})

describe("extractOutboundTargets", () => {
  it("returns nothing for a tool that is not outbound", () => {
    expect(extractOutboundTargets("send_session_message", { sessionId: "s" })).toEqual([])
    expect(extractOutboundTargets("read_file", {})).toEqual([])
  })

  it("extracts every broadcast target, deduplicated across threads", () => {
    const targets = extractOutboundTargets("mcp__cognia-skills__im_broadcast", {
      conversationKeys: [GROUP, `${GROUP}:om_t`, "slack:bot-s:C1"],
      message: "hi",
    })
    expect(targets.map((t) => t.recipient)).toEqual([
      "conv:lark:bot-a:oc_123",
      "conv:slack:bot-s:C1",
    ])
  })

  it("marks a malformed broadcast key unknown instead of dropping it", () => {
    const targets = extractOutboundTargets("im_broadcast", {
      conversationKeys: [GROUP, "broken"],
    })
    expect(targets.map((t) => t.kind)).toEqual(["conversation", "unknown"])
    expect(targets[1]).toEqual({ kind: "unknown", channel: "tool:im_broadcast", recipient: "*" })
  })

  it("scopes new-chat members to the named or default bot", () => {
    expect(
      extractOutboundTargets("im_create_chat", { name: "n", memberIds: ["ou_1"], adapterId: "x" })
    ).toEqual([{ kind: "person", channel: "x", recipient: "person:x:ou_1" }])
    expect(
      extractOutboundTargets(
        "im_create_chat",
        { name: "n", memberIds: ["ou_1", "ou_1"] },
        { defaultAdapterId: "bot-a" }
      )
    ).toEqual([{ kind: "person", channel: "bot-a", recipient: "person:bot-a:ou_1" }])
  })

  it("cannot scope members without a bot", () => {
    expect(extractOutboundTargets("im_create_chat", { name: "n", memberIds: ["ou_1"] })).toEqual([
      { kind: "unknown", channel: "tool:im_create_chat", recipient: "*" },
    ])
  })

  it("prefers an existing dispatch conversation over members", () => {
    expect(
      extractOutboundTargets("im_dispatch_task", {
        existingConversationKey: GROUP,
        memberIds: ["ou_1"],
        adapterId: "bot-a",
      })
    ).toEqual([conversationTarget(GROUP)])
    expect(
      extractOutboundTargets("im_dispatch_task", { memberIds: ["ou_2"], adapterId: "bot-a" })
    ).toEqual([personTarget("bot-a", "ou_2")])
  })

  it("reads a single conversationKey for the post and bridge tools", () => {
    for (const tool of [
      "team_post_to_chat",
      "connectors_send_message",
      "connector_send",
      "send_message",
    ]) {
      expect(extractOutboundTargets(tool, { conversationKey: GROUP, message: "x" })).toEqual([
        conversationTarget(GROUP),
      ])
      expect(extractOutboundTargets(tool, { to: "someone" })).toEqual([
        { kind: "unknown", channel: `tool:${tool}`, recipient: "*" },
      ])
    }
  })

  it("collects to, cc and bcc in every accepted shape", () => {
    const targets = extractOutboundTargets("send_email", {
      to: "Ada <ada@example.com>, bob@example.com",
      cc: ["carol@example.com", "ADA@example.com"],
      bcc: "dan@example.com; ",
      subject: "s",
    })
    expect(targets.map((t) => t.recipient)).toEqual([
      "mail:ada@example.com",
      "mail:bob@example.com",
      "mail:carol@example.com",
      "mail:dan@example.com",
    ])
    expect(extractOutboundTargets("send_email", { subject: "s" })).toEqual([
      { kind: "unknown", channel: "tool:send_email", recipient: "*" },
    ])
  })

  it("treats published links as public", () => {
    for (const tool of ["deploy_site", "filespace_share", "filespace_enable_webdav"]) {
      expect(extractOutboundTargets(tool, { anything: true })).toEqual([publicTarget(tool)])
    }
  })

  it("survives input that is not an object", () => {
    expect(extractOutboundTargets("im_broadcast", null)).toEqual([
      { kind: "unknown", channel: "tool:im_broadcast", recipient: "*" },
    ])
    expect(extractOutboundTargets("send_email", ["a@b.c"])[0]?.kind).toBe("unknown")
  })

  // Every listed tool has a dedicated branch: a well-formed call to it never
  // falls to the backstop `unknown`.
  it("names a resolved target for a well-formed call to every outbound tool", () => {
    const wellFormed: Record<string, unknown> = {
      conversationKey: GROUP,
      conversationKeys: [GROUP],
      memberIds: ["ou_1"],
      adapterId: "bot-a",
      to: "ada@example.com",
    }
    for (const tool of OUTBOUND_TOOL_IDS) {
      const targets = extractOutboundTargets(tool, wellFormed)
      expect(targets.length).toBeGreaterThan(0)
      expect(targets.every((t) => t.kind !== "unknown")).toBe(true)
    }
  })
})

describe("outboundFingerprint", () => {
  it("hashes channel and recipient only", () => {
    const target = conversationTarget(GROUP)!
    expect(outboundFingerprint(target)).toBe(sha256Hex("outbound|bot-a|conv:lark:bot-a:oc_123"))
    expect(outboundFingerprint(target)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is the same for the same recipient through different tools and bodies", () => {
    const a = extractOutboundTargets("team_post_to_chat", { conversationKey: GROUP, message: "a" })
    const b = extractOutboundTargets("im_broadcast", {
      conversationKeys: [`${GROUP}:om_t`],
      message: "reworded",
    })
    expect(outboundFingerprint(a[0]!)).toBe(outboundFingerprint(b[0]!))
  })

  it("differs per recipient and per channel", () => {
    expect(outboundFingerprint(personTarget("bot-a", "ou_1")!)).not.toBe(
      outboundFingerprint(personTarget("bot-a", "ou_2")!)
    )
    expect(outboundFingerprint(publicTarget("deploy_site"))).not.toBe(
      outboundFingerprint(publicTarget("filespace_share"))
    )
  })

  it("persists channel and fingerprint, never the recipient", () => {
    const review = toReviewTarget(mailTarget("ada@example.com")!)
    expect(review).toEqual({
      channel: "mail",
      fingerprint: sha256Hex("outbound|mail|mail:ada@example.com"),
    })
    expect(JSON.stringify(review)).not.toContain("ada")
  })
})
