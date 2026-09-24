import type { SendContent } from "@cognia/agent-config-types"
import { buildRouteTargets } from "@/lib/agent-team/runtime-targets"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import type { AgentTeammate } from "@/types/agent/agent-team"
import {
  isLeadingTokenPosition,
  parseLeadingMention,
  parseLeadingRoute,
  routeForTarget,
  stripLeadingRouteToken,
} from "./parse"

function teammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm-1",
    teamId: "s1",
    name: "Critic",
    description: "Pokes holes",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

const targets = buildRouteTargets({
  squads: [{ team: { id: "s1", name: "Platform" }, teammates: [teammate()] }],
})

function withPreamble(typed: string): string {
  return composeTurnText(typed, [{ kind: "references", text: "<ref>@codex quoted</ref>" }], {
    nonce: "n0nce12",
  }).text
}

describe("parseLeadingMention", () => {
  const candidates = [
    { id: "a", name: "Codex" },
    { id: "b", name: "codex" },
  ]

  it("matches only the first non-whitespace token, case-insensitively", () => {
    expect(parseLeadingMention("  @CODEX fix it", candidates)).toEqual({
      matchedName: "Codex",
      matchedId: "a",
      remainder: "fix it",
      unknownMention: false,
      rawToken: "@CODEX",
    })
  })

  it("reports an unknown leading mention with its remainder", () => {
    expect(parseLeadingMention("@nobody hi", candidates)).toMatchObject({
      matchedId: null,
      unknownMention: true,
      rawToken: "@nobody",
      remainder: "hi",
    })
  })

  it("is not a mention when the text does not start with @ or @ stands alone", () => {
    expect(parseLeadingMention("hi @codex", candidates).matchedId).toBeNull()
    expect(parseLeadingMention("@ codex", candidates)).toMatchObject({
      matchedId: null,
      unknownMention: false,
      rawToken: null,
    })
    expect(parseLeadingMention("", candidates).remainder).toBe("")
    expect(parseLeadingMention("   ", candidates).remainder).toBe("")
  })
})

describe("parseLeadingRoute", () => {
  it("resolves a leading runtime handle", () => {
    const parsed = parseLeadingRoute("@codex refactor the parser", targets)
    expect(parsed?.route).toEqual({
      target: { kind: "runtime", runtime: "codex" },
      handle: "codex",
      label: "codex",
    })
    expect(parsed?.remainder).toBe("refactor the parser")
    expect(parsed?.rawToken).toBe("@codex")
  })

  it("is case-insensitive and tolerates leading whitespace and newlines", () => {
    expect(parseLeadingRoute("\n  @Claude  hi", targets)?.route.handle).toBe("claude")
  })

  it("resolves a Squad member to its Squad and teammate", () => {
    expect(parseLeadingRoute("@critic review this", targets)?.route).toEqual({
      target: { kind: "squadMember", squadId: "s1", teammateId: "tm-1" },
      handle: "critic",
      label: "Critic",
    })
  })

  it("routes nothing when the handle is not the leading token", () => {
    expect(parseLeadingRoute("please ask @codex", targets)).toBeNull()
    expect(parseLeadingRoute("x @claude", targets)).toBeNull()
  })

  it("routes nothing for a bare @, an unknown handle or punctuation glued on", () => {
    expect(parseLeadingRoute("@ codex", targets)).toBeNull()
    expect(parseLeadingRoute("@unknown do it", targets)).toBeNull()
    expect(parseLeadingRoute("@codex, do it", targets)).toBeNull()
  })

  it("skips the context envelope, and a quoted @codex inside it routes nothing", () => {
    expect(parseLeadingRoute(withPreamble("@codex go"), targets)?.route.handle).toBe("codex")
    expect(parseLeadingRoute(withPreamble("no route here"), targets)).toBeNull()
  })
})

describe("routeForTarget", () => {
  it("maps the virtual claude target to the builtin runtime route", () => {
    expect(routeForTarget(targets[0]).target).toEqual({ kind: "runtime", runtime: "claude" })
  })
})

describe("isLeadingTokenPosition", () => {
  it("is true only when nothing but whitespace precedes the token", () => {
    expect(isLeadingTokenPosition("@co", 0)).toBe(true)
    expect(isLeadingTokenPosition("  \n@co", 3)).toBe(true)
    expect(isLeadingTokenPosition("hi @co", 3)).toBe(false)
    expect(isLeadingTokenPosition("@co", -1)).toBe(false)
  })
})

describe("stripLeadingRouteToken", () => {
  it("removes the leading handle from plain text", () => {
    expect(stripLeadingRouteToken("@codex fix it", "codex")).toBe("fix it")
    expect(stripLeadingRouteToken("  @CODEX\nfix it", "codex")).toBe("fix it")
  })

  it("leaves text alone when the handle does not lead, or nothing would remain", () => {
    expect(stripLeadingRouteToken("ask @codex", "codex")).toBe("ask @codex")
    expect(stripLeadingRouteToken("@codex", "codex")).toBe("@codex")
  })

  it("keeps the context envelope and strips the typed text behind it", () => {
    const text = withPreamble("@codex go")
    const stripped = stripLeadingRouteToken(text, "codex") as string
    expect(stripped).toBe(withPreamble("go"))
    expect(stripped).toContain("<ref>@codex quoted</ref>")
  })

  it("strips the first text block and leaves attachments untouched", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    } as const
    const content = [image, { type: "text", text: "@codex describe" }] as SendContent
    expect(stripLeadingRouteToken(content, "codex")).toEqual([
      image,
      { type: "text", text: "describe" },
    ])
  })

  it("skips attachment text blocks and strips the typed text behind them", () => {
    // An extracted document is a text block ahead of the typed text; it is
    // neither the question nor something a route may edit, even when it
    // happens to start with the same handle.
    const attachment = { type: "text", text: "@codex is mentioned in this file" } as const
    const content = [attachment, { type: "text", text: "@codex summarize" }] as SendContent
    expect(stripLeadingRouteToken(content, "codex", 1)).toEqual([
      attachment,
      { type: "text", text: "summarize" },
    ])
    const onlyHandle = [attachment, { type: "text", text: "@codex" }] as SendContent
    expect(stripLeadingRouteToken(onlyHandle, "codex", 1)).toEqual([attachment])
    expect(stripLeadingRouteToken([attachment] as SendContent, "codex", 1)).toEqual([attachment])
  })

  it("drops a text block that was only the handle when an attachment remains", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    } as const
    const content = [image, { type: "text", text: "@codex" }] as SendContent
    expect(stripLeadingRouteToken(content, "codex")).toEqual([image])
    const alone = [{ type: "text", text: "@codex" }] as SendContent
    expect(stripLeadingRouteToken(alone, "codex")).toBe(alone)
  })

  it("returns content without a text block as it was", () => {
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
    ] as SendContent
    expect(stripLeadingRouteToken(content, "codex")).toBe(content)
  })
})
