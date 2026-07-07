/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character, Skill, Team } from "@/lib/claude/types"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { TwinDraft } from "@/types/twin"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

import { DiscoverItemCard } from "./discover-item-card"

jest.mock("next-intl", () => ({
  // Most assertions read on the raw i18n key — keep that behavior, but
  // resolve the handful of templates that the test cases interpolate
  // (twinDraftFallbackName uses `{kind}` to render "character draft").
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === "card.twinDraftFallbackName" && params && typeof params.kind === "string") {
      return `${params.kind as string} draft`
    }
    return key
  },
  useLocale: () => "en",
}))

const mkCharacter = (
  id: string,
  name: string,
  overrides: Partial<Character> = {}
): DiscoverItem => ({
  kind: "character",
  id,
  data: {
    id,
    name,
    description: "",
    systemPrompt: "",
    avatarColor: "#abc",
    avatarEmoji: "🐙",
    isBuiltIn: false,
    ...overrides,
  } as unknown as Character,
})

const mkTeam = (id: string, name: string): DiscoverItem => ({
  kind: "team",
  id,
  data: {
    id,
    name,
    description: "team description",
    avatarColor: "#def",
    members: [],
    isBuiltIn: true,
  } as unknown as Team,
})

const mkSkill = (
  id: string,
  name: string,
  status: "enabled" | "disabled" = "enabled"
): DiscoverItem => ({
  kind: "skill",
  id,
  data: { id, name, content: "", status } as unknown as Skill,
})

const mkPlugin = (id: string, name: string, enabled = true): DiscoverItem => ({
  kind: "plugin",
  id,
  data: {
    id,
    name,
    version: "2.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled,
    capabilities: [],
    path: "",
    manifest: {},
    createdAt: 0,
    updatedAt: 0,
  } as PluginRow,
})

const mkTwinDraft = (id: string, name: string): DiscoverItem => ({
  kind: "twinDraft",
  id,
  data: {
    id,
    twinId: "twin_1",
    jobId: "job_1",
    kind: "skill",
    payload: { kind: "skill", data: { name } },
    provenance: { chunkIds: [], rationale: "auto-generated from notes" },
    status: "pending",
    createdAt: 0,
  } as unknown as TwinDraft,
})

describe("<DiscoverItemCard />", () => {
  it("renders a character with avatar fallback glyph + name", () => {
    render(
      <DiscoverItemCard item={mkCharacter("c1", "Alpha")} selected={false} onSelect={jest.fn()} />
    )
    expect(screen.getByTestId("discover-item-character-c1")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("shows the built-in badge for built-in items", () => {
    render(<DiscoverItemCard item={mkTeam("t1", "Squad")} selected={false} onSelect={jest.fn()} />)
    // The team factory marks isBuiltIn: true.
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
  })

  it("renders the description when present", () => {
    render(<DiscoverItemCard item={mkTeam("t1", "Squad")} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("team description")).toBeInTheDocument()
  })

  it("renders a disabled badge for skills whose status is disabled", () => {
    render(
      <DiscoverItemCard
        item={mkSkill("s1", "Lint", "disabled")}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    // Disabled skills surface the inspector.disable label via the secondary badge.
    expect(screen.getByText("inspector.disable")).toBeInTheDocument()
  })

  it("renders the version line for plugins", () => {
    render(<DiscoverItemCard item={mkPlugin("p1", "Demo")} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("v2.0.0")).toBeInTheDocument()
  })

  it("renders the rationale for twin drafts", () => {
    render(
      <DiscoverItemCard
        item={mkTwinDraft("d1", "Drafted skill")}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByText("auto-generated from notes")).toBeInTheDocument()
    expect(screen.getByText("skill")).toBeInTheDocument()
  })

  it("calls onSelect when clicked", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <DiscoverItemCard item={mkCharacter("c1", "Alpha")} selected={false} onSelect={onSelect} />
    )
    await user.click(screen.getByTestId("discover-item-character-c1"))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("sets aria-pressed=true when selected", () => {
    render(
      <DiscoverItemCard item={mkCharacter("c1", "Alpha")} selected={true} onSelect={jest.fn()} />
    )
    expect(screen.getByTestId("discover-item-character-c1")).toHaveAttribute("aria-pressed", "true")
  })

  it("falls back to id when a plugin's name is empty", () => {
    const item = mkPlugin("plug_42", "")
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("plug_42")).toBeInTheDocument()
  })

  it("falls back to '<kind> draft' when a twin draft payload has no name", () => {
    const draft: DiscoverItem = {
      kind: "twinDraft",
      id: "d2",
      data: {
        id: "d2",
        twinId: "twin_1",
        jobId: "job_1",
        kind: "character",
        payload: { kind: "character", data: {} },
        provenance: { chunkIds: [], rationale: "" },
        status: "pending",
        createdAt: 0,
      } as unknown as TwinDraft,
    }
    render(<DiscoverItemCard item={draft} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("character draft")).toBeInTheDocument()
  })

  // ── Phase 3 kinds ──────────────────────────────────────────────────────

  it("renders an MCP server with its transport and disabled badge when off", () => {
    const item: DiscoverItem = {
      kind: "mcpServer",
      id: "mcp_1",
      data: {
        id: "mcp_1",
        name: "Brave",
        transport: "stdio",
        config: {},
        enabled: false,
        appsEnabled: {},
        createdAt: 0,
        updatedAt: 0,
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Brave")).toBeInTheDocument()
    expect(screen.getByText("stdio")).toBeInTheDocument()
    expect(screen.getByText("inspector.disable")).toBeInTheDocument()
  })

  it("renders a connector with the i18n-resolved label + status badge", () => {
    const item: DiscoverItem = {
      kind: "connector",
      id: "telegram",
      data: {
        type: "telegram",
        iconName: "Send",
        status: "stable",
        oauth: false,
        richMessages: true,
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    // Name resolves through the t() mock as the i18n key itself.
    expect(screen.getByText("connectorLabels.telegram")).toBeInTheDocument()
    // stable platforms render the "built-in" badge instead of a status badge.
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
  })

  it("flags planned connectors with the planned status badge", () => {
    const item: DiscoverItem = {
      kind: "connector",
      id: "wecom",
      data: {
        type: "wecom",
        iconName: "Building2",
        status: "planned",
        oauth: true,
        richMessages: true,
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("connectorStatus.planned")).toBeInTheDocument()
  })

  it("renders an OCR provider with its category and credentials hint", () => {
    const item: DiscoverItem = {
      kind: "ocrProvider",
      id: "anthropic-vision",
      data: {
        id: "anthropic-vision",
        label: "Claude Vision",
        category: "llm-vision",
        shells: { browser: true, tauri: true, capacitor: false },
        credentialKeys: ["anthropicApiKey"],
        extract: jest.fn(),
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Claude Vision")).toBeInTheDocument()
    expect(screen.getByText("ocrCategories.llm-vision")).toBeInTheDocument()
    expect(screen.getByText("ocrBadge.needsCredentials")).toBeInTheDocument()
  })

  // ── Favorites + view variants ──────────────────────────────────────────

  it("renders a favorite star only when onToggleFavorite is provided", () => {
    const { rerender } = render(
      <DiscoverItemCard item={mkCharacter("c1", "Alpha")} selected={false} onSelect={jest.fn()} />
    )
    expect(screen.queryByTestId("discover-favorite-character-c1")).not.toBeInTheDocument()

    rerender(
      <DiscoverItemCard
        item={mkCharacter("c1", "Alpha")}
        selected={false}
        onSelect={jest.fn()}
        favorited={false}
        onToggleFavorite={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-favorite-character-c1")).toBeInTheDocument()
  })

  it("toggles favorite without triggering selection", async () => {
    const onSelect = jest.fn()
    const onToggleFavorite = jest.fn()
    const user = userEvent.setup()
    render(
      <DiscoverItemCard
        item={mkCharacter("c1", "Alpha")}
        selected={false}
        onSelect={onSelect}
        favorited={false}
        onToggleFavorite={onToggleFavorite}
      />
    )
    await user.click(screen.getByTestId("discover-favorite-character-c1"))
    expect(onToggleFavorite).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("marks the star pressed when favorited", () => {
    render(
      <DiscoverItemCard
        item={mkCharacter("c1", "Alpha")}
        selected={false}
        onSelect={jest.fn()}
        favorited
        onToggleFavorite={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-favorite-character-c1")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("still renders name in grid and compact views", () => {
    const { rerender } = render(
      <DiscoverItemCard
        item={mkCharacter("c1", "Alpha")}
        selected={false}
        onSelect={jest.fn()}
        view="grid"
      />
    )
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    rerender(
      <DiscoverItemCard
        item={mkCharacter("c1", "Alpha")}
        selected={false}
        onSelect={jest.fn()}
        view="compact"
      />
    )
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("renders a workflow template with its English label + first tag", () => {
    const item: DiscoverItem = {
      kind: "workflowTemplate",
      id: "github-pr",
      data: {
        id: "github-pr",
        label: { en: "GitHub PR", "zh-CN": "GitHub PR" },
        description: { en: "Review PRs", "zh-CN": "评审 PR" },
        iconName: "Workflow",
        tags: ["github", "ai"],
        slots: [],
        build: () => ({}) as never,
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("GitHub PR")).toBeInTheDocument()
    expect(screen.getByText("Review PRs")).toBeInTheDocument()
    expect(screen.getByText("github")).toBeInTheDocument()
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
  })

  // ── WF1 registry-backed kinds ───────────────────────────────────────────

  it("renders a slash command with a plugin badge for plugin-sourced commands", () => {
    const item: DiscoverItem = {
      kind: "slashCommand",
      id: "gitx.status",
      data: {
        id: "gitx.status",
        name: "gitx.status",
        description: "Show git status",
        source: "plugin",
        pluginId: "gitx",
        handler: jest.fn(),
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByTestId("discover-item-slashCommand-gitx.status")).toBeInTheDocument()
    expect(screen.getByText("Show git status")).toBeInTheDocument()
    expect(screen.getByText("plugin")).toBeInTheDocument()
  })

  it("renders an MCP preset with its emoji glyph + transport badge", () => {
    const item: DiscoverItem = {
      kind: "mcpPreset",
      id: "filesystem",
      data: {
        id: "filesystem",
        name: "Filesystem",
        description: "Read/write files",
        icon: "📁",
        transport: "stdio",
        config: {},
        fields: [],
        tags: ["files"],
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Filesystem")).toBeInTheDocument()
    expect(screen.getByText("📁")).toBeInTheDocument()
    expect(screen.getByText("stdio")).toBeInTheDocument()
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
  })

  it("renders a team template with its member count-ready shape + category badge", () => {
    const item: DiscoverItem = {
      kind: "teamTemplate",
      id: "parallel-review",
      data: {
        id: "parallel-review",
        name: "Parallel Review",
        description: "Split review",
        teammateCount: 3,
        category: "review",
        isBuiltIn: true,
      },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Parallel Review")).toBeInTheDocument()
    expect(screen.getByText("review")).toBeInTheDocument()
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
  })

  it("renders an external-agent preset with its first tag", () => {
    const item: DiscoverItem = {
      kind: "externalAgentPreset",
      id: "codex",
      data: { id: "codex", name: "Codex", description: "OpenAI Codex", tags: ["cli", "openai"] },
    }
    render(<DiscoverItemCard item={item} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getByText("cli")).toBeInTheDocument()
  })

  it("renders a subagent, marking host built-ins (no ':' in id) as built-in", () => {
    const builtIn: DiscoverItem = {
      kind: "subagent",
      id: "workflow-designer",
      data: {
        id: "workflow-designer",
        name: "Workflow Designer",
        description: "designs",
        prompt: "",
      },
    }
    const { rerender } = render(
      <DiscoverItemCard item={builtIn} selected={false} onSelect={jest.fn()} />
    )
    expect(screen.getByText("Workflow Designer")).toBeInTheDocument()
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
    expect(screen.getByText("subagent")).toBeInTheDocument()

    const plugin: DiscoverItem = {
      kind: "subagent",
      id: "gitx:reviewer",
      data: { id: "gitx:reviewer", name: "Reviewer", description: "reviews", prompt: "" },
    }
    rerender(<DiscoverItemCard item={plugin} selected={false} onSelect={jest.fn()} />)
    // Plugin subagents (id has ':') are not built-in.
    expect(screen.queryByText("builtInBadge")).not.toBeInTheDocument()
  })
})
