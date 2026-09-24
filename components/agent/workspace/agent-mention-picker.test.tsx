import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider, useTranslations } from "next-intl"
import {
  AgentMentionRow,
  SubagentMentionRow,
  filterMentionables,
  filterSubagents,
  filterTeamMembers,
  routeFailureText,
  routeRuntimeLabel,
} from "./agent-mention-picker"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"
import type { RouteLane } from "@/lib/chat/turn-route/types"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"
import type { Character } from "@cognia/agent-config-types"

const i18n = {
  agentTeamsWorkspace: {
    chat: {
      virtualTag: "Virtual",
      runtime: {
        claude: "Claude",
        codex: "Codex",
        claudeCode: "Claude Code",
        geminiCli: "Gemini",
        cursorCli: "Cursor",
      },
    },
  },
  agentRuntime: {
    engineAiSdk: "AI SDK, running {provider}",
    engineClaudeAgentSdk: "Anthropic Agent SDK, in the bundled sidecar",
  },
  chat: {
    composer: {
      route: {
        blocked: "{runtime} can't run here",
        blockedDetail: "{runtime} can't run here: {detail}",
        disabled: "External agents are turned off.",
        memberMissing: "@{handle} is no longer in a Squad.",
        memberRuntime: "{name} runs on {runtime}, which isn't available here.",
        notConfigured: "No {runtime} agent is set up.",
        runsOn: "Answers on {name}",
        starting: "{runtime} isn't ready yet",
        startingDetail: "{runtime} isn't ready yet: {detail}",
      },
    },
  },
}

const virtualClaude: MentionTarget = {
  kind: "virtual",
  id: "__virtual_claude__",
  name: "claude",
  handle: "claude",
  runtime: "claude",
  description: "Cognia builtin agent Claude",
}

const virtualCodex: MentionTarget = {
  kind: "virtual",
  id: "__virtual_codex__",
  name: "codex",
  handle: "codex",
  runtime: "codex",
  description: "OpenAI Codex CLI",
}

const teammateAlice: MentionTarget = {
  kind: "teammate",
  id: "tm-1",
  name: "Alice",
  handle: "alice",
  squadId: "s1",
  squadName: "Platform",
  runtime: "claude",
  description: "Frontend specialist",
  nameCollision: false,
  // teammate object is not used by the renderer
  teammate: { id: "tm-1", name: "Alice", avatarId: "designer" } as never,
}

const BUILTIN: AgentRuntimeDescriptor = {
  ref: { kind: "builtin" },
  key: "builtin",
  group: "builtin",
  descriptionKey: "engineAiSdk",
  descriptionValues: { provider: "deepseek" },
}

function renderRow(
  target: MentionTarget,
  extra: { highlighted?: boolean; lane?: RouteLane; descriptor?: AgentRuntimeDescriptor } = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={i18n} timeZone="UTC">
      <AgentMentionRow target={target} {...extra} />
    </NextIntlClientProvider>
  )
}

describe("AgentMentionRow", () => {
  it("renders the @handle + runtime badge for a virtual target", () => {
    renderRow(virtualClaude)
    const row = screen.getByTestId("agent-mention-row-__virtual_claude__")
    expect(row).toHaveAttribute("data-virtual", "true")
    expect(row).not.toHaveAttribute("data-unavailable")
    expect(screen.getByText("@claude")).toBeInTheDocument()
    expect(screen.getByText("Claude")).toBeInTheDocument()
    expect(screen.getByText("Virtual")).toBeInTheDocument()
    // The English search text is never shown.
    expect(screen.queryByText("Cognia builtin agent Claude")).toBeNull()
    expect(screen.getByTestId("agent-team-avatar-__virtual_claude__")).toHaveAttribute(
      "data-avatar-id",
      "researcher"
    )
  })

  it("names the engine that will really answer an @claude turn", () => {
    renderRow(virtualClaude, {
      lane: { ok: true, runtimeRef: { kind: "builtin" } },
      descriptor: BUILTIN,
    })
    expect(screen.getByText("AI SDK, running deepseek")).toBeInTheDocument()
  })

  it("names the configured agent that will answer an @codex turn", () => {
    renderRow(virtualCodex, {
      lane: { ok: true, runtimeRef: { kind: "external", agentId: "cx" } },
      descriptor: {
        ref: { kind: "external", agentId: "cx" },
        key: "k",
        group: "external",
        name: "My Codex",
      },
    })
    expect(screen.getByText("Answers on My Codex")).toBeInTheDocument()
  })

  it("dims an unavailable target and says why", () => {
    renderRow(virtualCodex, { lane: { ok: false, reason: "not-configured", runtime: "codex" } })
    const row = screen.getByTestId("agent-mention-row-__virtual_codex__")
    expect(row).toHaveAttribute("data-unavailable", "true")
    expect(row.className).toMatch(/opacity-60/)
    expect(screen.getByText("No Codex agent is set up.")).toBeInTheDocument()
  })

  it("renders a Squad member with its handle, Squad and description", () => {
    renderRow(teammateAlice)
    const row = screen.getByTestId("agent-mention-row-tm-1")
    expect(row).toHaveAttribute("data-virtual", "false")
    expect(screen.queryByText("Virtual")).toBeNull()
    expect(screen.getByText("@alice")).toBeInTheDocument()
    expect(screen.getByTestId("agent-mention-row-squad-tm-1")).toHaveTextContent("Platform")
    expect(screen.getByText("Frontend specialist")).toBeInTheDocument()
    expect(screen.getByTestId("agent-team-avatar-tm-1")).toHaveAttribute(
      "data-avatar-id",
      "designer"
    )
  })

  it("applies highlight class when highlighted is true", () => {
    renderRow(virtualCodex, { highlighted: true })
    const row = screen.getByTestId("agent-mention-row-__virtual_codex__")
    expect(row.className).toMatch(/bg-accent/)
  })
})

describe("routeFailureText", () => {
  // The provider is the i18n fixture; `useTranslations` needs it, so render a
  // probe that hands the translators out.
  function withTranslators(run: (t: never, tRuntime: never) => void) {
    function Probe() {
      const t = useTranslations("chat.composer.route")
      const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
      run(t as never, tRuntime as never)
      return null
    }
    render(
      <NextIntlClientProvider locale="en" messages={i18n} timeZone="UTC">
        <Probe />
      </NextIntlClientProvider>
    )
  }

  it("has one sentence per failure, with the runtime's own wording kept", () => {
    const target = { handle: "alice", name: "Alice" }
    const cases: Array<[Extract<RouteLane, { ok: false }>, string]> = [
      [{ ok: false, reason: "not-configured", runtime: "codex" }, "No Codex agent is set up."],
      [{ ok: false, reason: "disabled", runtime: "codex" }, "External agents are turned off."],
      [
        { ok: false, reason: "blocked", runtime: "codex", detail: "codex: not found" },
        "Codex can't run here: codex: not found",
      ],
      [{ ok: false, reason: "blocked", runtime: "codex" }, "Codex can't run here"],
      [
        { ok: false, reason: "transient", runtime: "codex", detail: "Host starting" },
        "Codex isn't ready yet: Host starting",
      ],
      [{ ok: false, reason: "transient", runtime: "codex" }, "Codex isn't ready yet"],
      [{ ok: false, reason: "member-missing" }, "@alice is no longer in a Squad."],
      [
        { ok: false, reason: "member-runtime", runtime: "gemini-cli" },
        "Alice runs on Gemini, which isn't available here.",
      ],
    ]
    withTranslators((t, tRuntime) => {
      for (const [lane, text] of cases) {
        expect(routeFailureText(lane, target, t, tRuntime)).toBe(text)
      }
    })
  })

  it("labels a plugin preset by its id", () => {
    withTranslators((_t, tRuntime) => {
      expect(routeRuntimeLabel(tRuntime, "plugin-preset")).toBe("plugin-preset")
      expect(routeRuntimeLabel(tRuntime, undefined)).toBe("")
      expect(routeRuntimeLabel(tRuntime, "claude-code")).toBe("Claude Code")
    })
  })
})

describe("filterMentionables", () => {
  const all: MentionTarget[] = [virtualClaude, virtualCodex, teammateAlice]

  it("returns all entries on empty query", () => {
    expect(filterMentionables(all, "")).toEqual(all)
  })

  it("matches by case-insensitive handle prefix first", () => {
    const out = filterMentionables(all, "co")
    expect(out[0]).toBe(virtualCodex)
  })

  it("falls through to the display name for a member whose handle differs", () => {
    const qualified: MentionTarget = { ...teammateAlice, handle: "platform-alice" } as MentionTarget
    expect(filterMentionables([qualified], "Alice")).toEqual([qualified])
  })

  it("falls through to substring match", () => {
    const out = filterMentionables(all, "cli") // matches "Codex CLI" desc
    expect(out.some((t) => t.id === virtualCodex.id)).toBe(true)
  })

  it("returns empty when nothing matches", () => {
    expect(filterMentionables(all, "zzzz")).toEqual([])
  })

  it("matches a gapped subsequence (fuzzy)", () => {
    // "cdx" is a subsequence of "codex" but not a substring — the old
    // substring matcher would have missed it; the shared fuzzy scorer hits it.
    const out = filterMentionables(all, "cdx")
    expect(out.some((t) => t.id === virtualCodex.id)).toBe(true)
  })
})

describe("SubagentMentionRow", () => {
  const reviewer: SubagentMentionTarget = {
    id: "template:my-reviewer",
    name: "My Reviewer",
    description: "Reviews code",
    model: "opus",
    handle: "my-reviewer",
  }
  const noModel: SubagentMentionTarget = {
    id: "workflow-designer",
    name: "Workflow Designer",
    description: "",
    handle: "workflow-designer",
  }

  it("renders @handle, the model badge, and the description", () => {
    render(<SubagentMentionRow target={reviewer} />)
    expect(screen.getByTestId("subagent-mention-row-template:my-reviewer")).toBeInTheDocument()
    expect(screen.getByText("@my-reviewer")).toBeInTheDocument()
    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByText("Reviews code")).toBeInTheDocument()
  })

  it("omits the model badge and description when absent", () => {
    render(<SubagentMentionRow target={noModel} />)
    expect(screen.getByText("@workflow-designer")).toBeInTheDocument()
    expect(screen.queryByText("opus")).toBeNull()
  })

  it("applies the highlight class when highlighted", () => {
    render(<SubagentMentionRow target={reviewer} highlighted />)
    expect(screen.getByTestId("subagent-mention-row-template:my-reviewer").className).toMatch(
      /bg-accent/
    )
  })
})

describe("filterSubagents", () => {
  const all: SubagentMentionTarget[] = [
    {
      id: "workflow-designer",
      name: "Workflow Designer",
      description: "Designs flows",
      handle: "workflow-designer",
    },
    {
      id: "template:my-reviewer",
      name: "My Reviewer",
      description: "Reviews code",
      handle: "my-reviewer",
    },
  ]

  it("returns all entries on empty query", () => {
    expect(filterSubagents(all, "")).toEqual(all)
  })

  it("matches by the @handle (primary)", () => {
    const out = filterSubagents(all, "rev")
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("template:my-reviewer")
  })

  it("falls through to the description (secondary)", () => {
    const out = filterSubagents(all, "designs")
    expect(out.some((t) => t.id === "workflow-designer")).toBe(true)
  })

  it("returns empty when nothing matches", () => {
    expect(filterSubagents(all, "zzzz")).toEqual([])
  })
})

describe("filterTeamMembers", () => {
  const all = [
    { id: "c1", name: "Critic", description: "Pokes holes", avatarColor: "#000" },
    { id: "c2", name: "Researcher", avatarColor: "#111" },
  ] as Character[]

  it("keeps room order on an empty query", () => {
    expect(filterTeamMembers(all, "")).toEqual(all)
  })

  it("matches by the character name, which is what a member pick inserts", () => {
    expect(filterTeamMembers(all, "res").map((m) => m.id)).toEqual(["c2"])
  })

  it("falls through to the description, and tolerates a member without one", () => {
    expect(filterTeamMembers(all, "holes").map((m) => m.id)).toEqual(["c1"])
  })

  it("returns empty when nothing matches", () => {
    expect(filterTeamMembers(all, "zzzz")).toEqual([])
  })
})
