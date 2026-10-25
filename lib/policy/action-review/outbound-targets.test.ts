import { sha256Hex } from "@cognia/agent"

import { OUTBOUND_TOOL_IDS } from "@/lib/policy/risk/outbound-tools"

import {
  conversationTarget,
  extractOutboundTargets,
  mailTarget,
  originMatchFingerprint,
  outboundCategoryOf,
  outboundFingerprint,
  outboundRecipientId,
  personTarget,
  publicTarget,
  repositoryTarget,
  siteTarget,
  toReviewTarget,
  unknownGithubTarget,
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

describe("repositoryTarget (ADR-0239 phase 2)", () => {
  const ACME = "github:github.com/acme/web"

  it.each([
    "acme/web",
    "Acme/Web",
    "github.com/acme/web",
    "https://github.com/acme/web",
    "https://www.github.com/Acme/Web.git",
    "https://github.com/acme/web/pull/12",
    "git@github.com:acme/web.git",
    "ssh://git@github.com/acme/web.git",
  ])("names %s as the repository", (input) => {
    expect(repositoryTarget(input)).toEqual({
      kind: "repository",
      channel: "github",
      recipient: ACME,
    })
  })

  it("keeps another host", () => {
    expect(repositoryTarget("ghe.corp.example/team/svc")?.recipient).toBe(
      "github:ghe.corp.example/team/svc"
    )
    expect(repositoryTarget("https://ghe.corp.example:8443/team/svc")?.recipient).toBe(
      "github:ghe.corp.example:8443/team/svc"
    )
  })

  it("carries a thread, which a write's fingerprint ignores", () => {
    const onPr = repositoryTarget("acme/web", 12)!
    expect(onPr.thread).toBe("12")
    expect(repositoryTarget("acme/web", "#12")!.thread).toBe("12")
    expect(outboundFingerprint(onPr)).toBe(outboundFingerprint(repositoryTarget("acme/web")!))
    expect(toReviewTarget(onPr)).toEqual(toReviewTarget(repositoryTarget("acme/web")!))
  })

  it.each([
    "",
    "acme",
    "acme/web/extra",
    "-acme/web",
    "acme/..",
    "acme/we b",
    "ftp://github.com/acme/web",
    "https://github.com/acme",
  ])("refuses %j", (input) => {
    expect(repositoryTarget(input)).toBeUndefined()
  })

  it("refuses a thread that is not a number", () => {
    expect(repositoryTarget("acme/web", "abc")).toBeUndefined()
    expect(repositoryTarget("acme/web", 0)).toBeUndefined()
  })
})

describe("siteTarget (ADR-0239 phase 2)", () => {
  it("names the origin a submission sends to", () => {
    expect(siteTarget("https://Forms.Example.com:443/submit?x=1")).toEqual({
      kind: "site",
      channel: "browser",
      recipient: "site:https://forms.example.com",
    })
    expect(siteTarget("http://localhost:3000/a")?.recipient).toBe("site:http://localhost:3000")
    expect(siteTarget("https://bücher.example/")?.recipient).toBe(
      "site:https://xn--bcher-kva.example"
    )
  })

  it("tells http and https apart", () => {
    expect(siteTarget("http://example.com")?.recipient).not.toBe(
      siteTarget("https://example.com")?.recipient
    )
  })

  it.each(["", "not a url", "file:///etc/passwd", "data:text/html,x", "javascript:alert(1)"])(
    "refuses %j",
    (input) => {
      expect(siteTarget(input)).toBeUndefined()
    }
  )
})

describe("outboundCategoryOf", () => {
  it("sorts targets into the three modes", () => {
    expect(outboundCategoryOf(conversationTarget(GROUP)!)).toBe("messaging")
    expect(outboundCategoryOf(mailTarget("a@b.co")!)).toBe("messaging")
    expect(outboundCategoryOf(publicTarget("deploy_site"))).toBe("messaging")
    expect(outboundCategoryOf(repositoryTarget("acme/web")!)).toBe("github")
    expect(outboundCategoryOf(siteTarget("https://example.com")!)).toBe("browser")
    // A GitHub write whose repository could not be named is still a GitHub write.
    expect(outboundCategoryOf({ kind: "unknown", channel: "github" })).toBe("github")
    expect(outboundCategoryOf({ kind: "unknown", channel: "browser" })).toBe("browser")
    expect(outboundCategoryOf(unknownGithubTarget())).toBe("github")
  })
})

describe("unknownGithubTarget", () => {
  it("is never grantable and matches no origin", () => {
    const target = unknownGithubTarget()
    expect(target).toEqual({ kind: "unknown", channel: "github", recipient: "*" })
    expect(originMatchFingerprint(target)).toBeUndefined()
  })
})

describe("originMatchFingerprint", () => {
  it("matches a conversation as itself", () => {
    const chat = conversationTarget(GROUP)!
    expect(originMatchFingerprint(chat)).toBe(outboundFingerprint(chat))
  })

  it("matches a repository only through its thread", () => {
    const pr12 = repositoryTarget("acme/web", 12)!
    expect(originMatchFingerprint(pr12)).toBe(
      sha256Hex("outbound|github|github-thread:github.com/acme/web#12")
    )
    expect(originMatchFingerprint(pr12)).not.toBe(
      originMatchFingerprint(repositoryTarget("acme/web", 13)!)
    )
    expect(originMatchFingerprint(repositoryTarget("acme/web")!)).toBeUndefined()
    expect(originMatchFingerprint(mailTarget("a@b.co")!)).toBeUndefined()
  })
})

describe("outboundRecipientId", () => {
  it("strips the prefixes a recipient is keyed by", () => {
    expect(outboundRecipientId(conversationTarget("lark:bot-a:oc_1:om_2")!)).toBe("oc_1")
    expect(outboundRecipientId(personTarget("bot-a", "ou_7")!)).toBe("ou_7")
    expect(outboundRecipientId(mailTarget("Ann <A@B.co>")!)).toBe("a@b.co")
    expect(outboundRecipientId(publicTarget("deploy_site"))).toBe("deploy_site")
    expect(outboundRecipientId(repositoryTarget("acme/web")!)).toBe("acme/web")
    expect(outboundRecipientId(repositoryTarget("ghe.corp.example/team/svc")!)).toBe(
      "ghe.corp.example/team/svc"
    )
    expect(outboundRecipientId(siteTarget("https://example.com/x")!)).toBe("https://example.com")
    expect(outboundRecipientId({ kind: "unknown", recipient: "*" })).toBe("*")
  })

  it("keeps a chat id that itself contains the separator", () => {
    expect(outboundRecipientId(conversationTarget("matrix:mx:!room:example.org")!)).toBe(
      "!room:example.org"
    )
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
