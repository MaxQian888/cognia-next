/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character, Skill, Team } from "@/lib/claude/types"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { TwinDraft } from "@/types/twin"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && Object.keys(vars).length > 0) return key + ":" + JSON.stringify(vars)
    return key
  },
  useLocale: () => "en",
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode; href?: string }) => (
    <a {...props}>{children}</a>
  ),
}))

jest.mock("@/components/mobile/discover/character-detail-sheet", () => ({
  CharacterDetailSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="character-detail-sheet" /> : null,
}))

const setSkillStatusMock = jest.fn()
jest.mock("@/lib/db/skills", () => ({
  setSkillStatus: (...args: unknown[]) => setSkillStatusMock(...args),
}))

const enqueueMock = jest.fn()
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (input: unknown) => {
    enqueueMock(input)
    return Promise.resolve()
  },
}))

const pluginUpdateMock = jest.fn().mockResolvedValue(undefined)
const mcpUpdateMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    plugins: { update: (id: string, patch: unknown) => pluginUpdateMock(id, patch) },
    mcpServers: { update: (id: string, patch: unknown) => mcpUpdateMock(id, patch) },
  }),
}))

const toastErrorMock = jest.fn()
const toastSuccessMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (msg: string) => toastErrorMock(msg),
    success: (msg: string) => toastSuccessMock(msg),
  },
}))

// Plugin marketplace + mobile/desktop platform — wired into the PluginInspector
// in Phase 4. The default mock pretends we're on desktop with an empty install
// queue and no listings to keep the existing tests focused on enable/disable.
const marketInstallMock = jest.fn().mockResolvedValue(undefined)
const marketUninstallMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/hooks/plugins/use-plugin-marketplace", () => ({
  usePluginMarketplace: () => ({
    query: "",
    setQuery: jest.fn(),
    state: { kind: "ready", results: [] },
    featured: [],
    popular: [],
    recent: [],
    install: marketInstallMock,
    uninstall: marketUninstallMock,
    refresh: jest.fn(),
    installingId: null,
  }),
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn().mockResolvedValue([]),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstancesByType: jest.fn().mockResolvedValue([]),
}))

import { DiscoverInspector } from "./discover-inspector"

const character: Character = {
  id: "c1",
  name: "Alpha",
  description: "Loves to chat",
  systemPrompt: "",
  avatarColor: "#abc",
  avatarEmoji: "🐙",
  isBuiltIn: true,
} as unknown as Character

const team: Team = {
  id: "t1",
  name: "Squad",
  description: "Team bio",
  avatarColor: "#def",
  members: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
  isBuiltIn: false,
} as unknown as Team

const skill: Skill = {
  id: "s1",
  name: "Code Skill",
  description: "writes code",
  content: "",
  status: "enabled",
} as unknown as Skill

const plugin: PluginRow = {
  id: "plug_42",
  name: "Demo plugin",
  version: "1.2.3",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: [],
  path: "",
  manifest: {},
  createdAt: 0,
  updatedAt: 0,
}

const draft: TwinDraft = {
  id: "d1",
  twinId: "twin_1",
  jobId: "job_1",
  kind: "character",
  payload: { kind: "character", data: { name: "Drafted Alpha" } },
  provenance: { chunkIds: [], rationale: "Distilled from notes" },
  status: "pending",
  createdAt: 0,
} as unknown as TwinDraft

const characterItem: DiscoverItem = { kind: "character", id: character.id, data: character }
const teamItem: DiscoverItem = { kind: "team", id: team.id, data: team }
const skillItem: DiscoverItem = { kind: "skill", id: skill.id, data: skill }
const pluginItem: DiscoverItem = { kind: "plugin", id: plugin.id, data: plugin }
const draftItem: DiscoverItem = { kind: "twinDraft", id: draft.id, data: draft }

beforeEach(() => {
  setSkillStatusMock.mockReset()
  enqueueMock.mockReset()
  pluginUpdateMock.mockReset().mockResolvedValue(undefined)
  mcpUpdateMock.mockReset().mockResolvedValue(undefined)
  toastErrorMock.mockReset()
  toastSuccessMock.mockReset()
  marketInstallMock.mockReset().mockResolvedValue(undefined)
  marketUninstallMock.mockReset().mockResolvedValue(undefined)
  platformValue = "web"
})

describe("<DiscoverInspector />", () => {
  it("renders the empty state with item count when nothing is selected", () => {
    render(
      <DiscoverInspector
        category="characters"
        itemId={null}
        items={[characterItem, characterItem]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-inspector-empty")).toBeInTheDocument()
    expect(screen.getByText("inspector.empty")).toBeInTheDocument()
  })

  it("renders the character title and edit button when a character is selected", async () => {
    const user = userEvent.setup()
    render(
      <DiscoverInspector
        category="characters"
        itemId={character.id}
        items={[characterItem]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-inspector-title")).toHaveTextContent("Alpha")
    expect(screen.queryByTestId("character-detail-sheet")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("discover-inspector-edit-character"))
    expect(screen.getByTestId("character-detail-sheet")).toBeInTheDocument()
  })

  it("renders the team detail with a link to /agent-teams/{id}", () => {
    render(
      <DiscoverInspector category="teams" itemId={team.id} items={[teamItem]} onClose={jest.fn()} />
    )
    // `<Button asChild>` flattens into the child `<a>` from next/link, so
    // the testid lands on the anchor itself — no nested querySelector needed.
    const link = screen.getByTestId("discover-inspector-open-team")
    expect(link).toHaveAttribute("href", "/agent-teams/workspace?teamId=t1")
  })

  it("calls setSkillStatus + enqueue when toggling a skill", async () => {
    const user = userEvent.setup()
    render(
      <DiscoverInspector
        category="skills"
        itemId={skill.id}
        items={[skillItem]}
        onClose={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-inspector-skill-toggle"))
    expect(setSkillStatusMock).toHaveBeenCalledWith(skill.id, "disabled")
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "skill_set_enabled",
        payload: { id: skill.id, enabled: false },
      })
    )
  })

  it("calls plugins.update + enqueue when toggling a plugin", async () => {
    const user = userEvent.setup()
    render(
      <DiscoverInspector
        category="plugins"
        itemId={plugin.id}
        items={[pluginItem]}
        onClose={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-inspector-plugin-toggle"))
    expect(pluginUpdateMock).toHaveBeenCalledWith(
      plugin.id,
      expect.objectContaining({ enabled: false })
    )
    // enqueue happens after the await resolves
    await new Promise((r) => setTimeout(r, 0))
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "plugin_set_enabled",
        payload: { id: plugin.id, enabled: false },
      })
    )
  })

  it("surfaces an error toast when the plugin write fails", async () => {
    pluginUpdateMock.mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    render(
      <DiscoverInspector
        category="plugins"
        itemId={plugin.id}
        items={[pluginItem]}
        onClose={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-inspector-plugin-toggle"))
    await new Promise((r) => setTimeout(r, 0))
    expect(toastErrorMock).toHaveBeenCalledWith("boom")
  })

  it("renders the twin draft rationale + link to /twin", () => {
    render(
      <DiscoverInspector
        category="twinDrafts"
        itemId={draft.id}
        items={[draftItem]}
        onClose={jest.fn()}
      />
    )
    // Header renders the payload.data.name via displayName(); body shows
    // the rationale.
    expect(screen.getByTestId("discover-inspector-title")).toHaveTextContent("Drafted Alpha")
    expect(screen.getByText("Distilled from notes")).toBeInTheDocument()
    const link = screen.getByTestId("discover-inspector-open-twin")
    expect(link).toHaveAttribute("href", "/twin")
  })

  it("calls onClose when the close button is clicked", async () => {
    const onClose = jest.fn()
    const user = userEvent.setup()
    render(
      <DiscoverInspector
        category="characters"
        itemId={character.id}
        items={[characterItem]}
        onClose={onClose}
      />
    )
    await user.click(screen.getByTestId("discover-inspector-close"))
    expect(onClose).toHaveBeenCalled()
  })

  // ── Phase 3 inspectors ─────────────────────────────────────────────────

  it("renders the MCP server inspector with a transport badge + toggle", async () => {
    const user = userEvent.setup()
    const server = {
      id: "mcp_1",
      name: "Brave",
      transport: "stdio" as const,
      config: {},
      enabled: true,
      appsEnabled: {},
      createdAt: 0,
      updatedAt: 0,
    }
    render(
      <DiscoverInspector
        category="mcpTools"
        itemId={server.id}
        items={[{ kind: "mcpServer", id: server.id, data: server }]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("stdio")).toBeInTheDocument()
    expect(screen.getByTestId("discover-inspector-mcp-toggle")).toBeInTheDocument()
    await user.click(screen.getByTestId("discover-inspector-mcp-toggle"))
    expect(mcpUpdateMock).toHaveBeenCalledWith(
      server.id,
      expect.objectContaining({ enabled: false })
    )
  })

  it("renders the connector inspector with status + a deep link to /settings/connections", () => {
    const connector = {
      type: "telegram" as const,
      iconName: "Send",
      status: "stable" as const,
      oauth: false,
      richMessages: true,
    }
    render(
      <DiscoverInspector
        category="connectors"
        itemId={connector.type}
        items={[{ kind: "connector", id: connector.type, data: connector }]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("connectorStatus.stable")).toBeInTheDocument()
    expect(screen.getByText("A2UI")).toBeInTheDocument()
    const link = screen.getByTestId("discover-inspector-open-connector")
    expect(link).toHaveAttribute("href", "/settings/connections?platform=telegram")
  })

  it("disables the connector link when the platform is planned-only", () => {
    const planned = {
      type: "wecom" as const,
      iconName: "Building2",
      status: "planned" as const,
      oauth: true,
      richMessages: true,
    }
    render(
      <DiscoverInspector
        category="connectors"
        itemId={planned.type}
        items={[{ kind: "connector", id: planned.type, data: planned }]}
        onClose={jest.fn()}
      />
    )
    const link = screen.getByTestId("discover-inspector-open-connector")
    expect(link).toHaveAttribute("aria-disabled", "true")
    expect(link).toHaveAttribute("href", "#")
  })

  it("renders the OCR provider inspector with the credential hint when required", () => {
    const provider = {
      id: "anthropic-vision",
      label: "Claude Vision",
      category: "llm-vision" as const,
      shells: { browser: true, tauri: true, capacitor: false },
      credentialKeys: ["anthropicApiKey"] as readonly string[],
      extract: jest.fn(),
    }
    render(
      <DiscoverInspector
        category="ocrProviders"
        itemId={provider.id}
        items={[{ kind: "ocrProvider", id: provider.id, data: provider }]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("ocrCategories.llm-vision")).toBeInTheDocument()
    expect(
      screen.getByText((content) => content.includes("ocrBadge.needsCredentials"))
    ).toBeInTheDocument()
    const link = screen.getByTestId("discover-inspector-open-ocr")
    expect(link).toHaveAttribute("href", "/settings/ocr")
  })

  it("renders the workflow template inspector with locale-aware description + tags", () => {
    const template = {
      id: "github-pr",
      label: { en: "GitHub PR", "zh-CN": "GitHub PR" },
      description: { en: "Auto-review pull requests.", "zh-CN": "自动评审 PR。" },
      iconName: "Workflow",
      tags: ["github", "review"],
      slots: [],
      build: () => ({}) as never,
    }
    render(
      <DiscoverInspector
        category="workflowTemplates"
        itemId={template.id}
        items={[{ kind: "workflowTemplate", id: template.id, data: template }]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("Auto-review pull requests.")).toBeInTheDocument()
    expect(screen.getByText("github")).toBeInTheDocument()
    expect(screen.getByText("review")).toBeInTheDocument()
    const link = screen.getByTestId("discover-inspector-open-template")
    expect(link).toHaveAttribute("href", "/workflows?template=github-pr")
  })

  // ── Phase 4 — plugin marketplace wiring ────────────────────────────────

  it("renders the Browse marketplace CTA in the plugins empty state", () => {
    render(<DiscoverInspector category="plugins" itemId={null} items={[]} onClose={jest.fn()} />)
    expect(screen.getByTestId("discover-marketplace-trigger")).toBeInTheDocument()
  })

  it("does NOT render the marketplace CTA for non-plugin empty states", () => {
    render(<DiscoverInspector category="skills" itemId={null} items={[]} onClose={jest.fn()} />)
    expect(screen.queryByTestId("discover-marketplace-trigger")).not.toBeInTheDocument()
  })

  it("renders an uninstall button for marketplace-installed plugins on desktop", () => {
    render(
      <DiscoverInspector
        category="plugins"
        itemId={plugin.id}
        items={[pluginItem]}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-inspector-plugin-uninstall")).toBeInTheDocument()
  })

  it("hides the uninstall button for built-in plugins", () => {
    const builtin: PluginRow = { ...plugin, source: "builtin" }
    render(
      <DiscoverInspector
        category="plugins"
        itemId={builtin.id}
        items={[{ kind: "plugin", id: builtin.id, data: builtin }]}
        onClose={jest.fn()}
      />
    )
    expect(screen.queryByTestId("discover-inspector-plugin-uninstall")).not.toBeInTheDocument()
  })

  it("hides the uninstall button on Capacitor mobile", () => {
    platformValue = "mobile"
    render(
      <DiscoverInspector
        category="plugins"
        itemId={plugin.id}
        items={[pluginItem]}
        onClose={jest.fn()}
      />
    )
    expect(screen.queryByTestId("discover-inspector-plugin-uninstall")).not.toBeInTheDocument()
  })

  it("calls market.uninstall when the user clicks the uninstall button", async () => {
    const user = userEvent.setup()
    render(
      <DiscoverInspector
        category="plugins"
        itemId={plugin.id}
        items={[pluginItem]}
        onClose={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-inspector-plugin-uninstall"))
    expect(marketUninstallMock).toHaveBeenCalledWith(plugin.id)
    // Sonner toast fires after the await resolves
    await new Promise((r) => setTimeout(r, 0))
    expect(toastSuccessMock).toHaveBeenCalled()
  })
})
