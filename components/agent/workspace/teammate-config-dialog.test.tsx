/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    try {
      return fn()
    } catch {
      return undefined
    }
  },
}))

jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn() }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn() }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn() }))

jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => ({
  listNativeAnthropicToolEntries: () => [],
}))
jest.mock("@/lib/plugin/registries/character-pack-registry", () => ({
  listAllPackCharacters: () => [],
}))
jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => Promise.resolve([]),
}))
jest.mock("@/lib/claude/agents/subagents", () => ({
  resolveAllSubagents: () => ({}),
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  getAvailablePresets: () => [],
  getPresetDisplayInfo: () => null,
  // The runtime Select derives its options from the real preset catalog (via
  // `runtime-options`). Keep that export REAL — a hand-listed copy here would
  // reintroduce exactly the drift `runtime-options` exists to prevent.
  BUILTIN_EXECUTABLE_PRESET_IDS: jest.requireActual("@/lib/ai/agent/external/presets")
    .BUILTIN_EXECUTABLE_PRESET_IDS,
}))

const updateTeammateMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({ updateTeammate: updateTeammateMock }),
}))

const mockSettings: { settings: unknown } = { settings: null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(mockSettings),
}))

import { TeammateConfigDialog } from "./teammate-config-dialog"
import { getProviderDisplayName } from "@/lib/ai/icons"
import { listTwins } from "@/lib/db/twins"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

const listTwinsMock = listTwins as jest.Mock

const TWINS = [
  { id: "tw1", name: "Alice", createdAt: 0, updatedAt: 0 },
  { id: "tw2", name: "Bob", createdAt: 0, updatedAt: 0 },
]

/** Scope down to the twin `<Select>` via its label, since PresetEditor renders other selects too. */
function getTwinSelectTrigger() {
  const label = screen.getByText("rosterSection.twin")
  const block = label.closest("div")!
  return within(block).getByRole("combobox")
}

const team: AgentTeam = {
  id: "team-1",
  name: "Test Team",
  description: "",
  task: "task",
  status: "idle",
  config: { ...DEFAULT_TEAM_CONFIG },
  leadId: "lead-1",
  teammateIds: ["lead-1", "t1"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
}

const teammate: AgentTeammate = {
  id: "t1",
  teamId: "team-1",
  name: "Alice",
  description: "Reviewer",
  role: "teammate",
  status: "idle",
  config: {},
  completedTaskIds: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  progress: 0,
  createdAt: new Date(),
}

const lead: AgentTeammate = { ...teammate, id: "lead-1", name: "Lead", role: "lead" }

describe("TeammateConfigDialog", () => {
  beforeEach(() => {
    updateTeammateMock.mockReset()
    listTwinsMock.mockReset()
    listTwinsMock.mockReturnValue(TWINS)
    mockSettings.settings = {
      defaultProvider: "anthropic",
      providerSettings: {
        anthropic: { enabled: true, apiKey: "k" },
        openai: { enabled: true, apiKey: "k" },
        disabled_one: { enabled: false, apiKey: "k" },
      },
      customProviders: [{ id: "my-gateway", name: "GW", baseURL: "https://x/v1" }],
    }
  })

  describe("lead provider selector", () => {
    // The lead is never dispatched through a runtime — it runs its planning and
    // review turns on a resolved provider — so it is the one member for which
    // picking a provider is meaningful.
    function getProviderTrigger() {
      return screen.getByTestId("lead-provider-select")
    }

    it("offers the configured providers to a lead", async () => {
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={lead} team={team} />
      )

      fireEvent.click(getProviderTrigger())

      // Labelled by display name, not the raw id the user never typed.
      expect(
        await screen.findByRole("option", { name: getProviderDisplayName("anthropic") })
      ).toBeInTheDocument()
      expect(
        screen.getByRole("option", { name: getProviderDisplayName("openai") })
      ).toBeInTheDocument()
      // A custom provider carries its own name; the catalog does not know it.
      expect(screen.getByRole("option", { name: "GW" })).toBeInTheDocument()
      // A provider the user turned off cannot run the lead.
      expect(
        screen.queryByRole("option", { name: getProviderDisplayName("disabled_one") })
      ).not.toBeInTheDocument()
    })

    it("persists the picked provider onto the lead's config", async () => {
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={lead} team={team} />
      )

      fireEvent.click(getProviderTrigger())
      fireEvent.click(await screen.findByRole("option", { name: getProviderDisplayName("openai") }))

      expect(updateTeammateMock).toHaveBeenCalledWith(
        "lead-1",
        expect.objectContaining({ config: expect.objectContaining({ provider: "openai" }) })
      )
    })

    it("clears the override back to the app default", async () => {
      render(
        <TeammateConfigDialog
          open={true}
          onOpenChange={() => {}}
          teammate={{ ...lead, config: { provider: "openai" } }}
          team={team}
        />
      )

      fireEvent.click(getProviderTrigger())
      fireEvent.click(await screen.findByRole("option", { name: "rosterSection.providerDefault" }))

      expect(updateTeammateMock).toHaveBeenCalledWith(
        "lead-1",
        expect.objectContaining({ config: expect.objectContaining({ provider: undefined }) })
      )
    })

    it("is not offered for a non-lead teammate", () => {
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={teammate} team={team} />
      )
      expect(screen.queryByTestId("lead-provider-select")).not.toBeInTheDocument()
    })

    it("renders for a lead even before settings have loaded", () => {
      mockSettings.settings = null
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={lead} team={team} />
      )
      expect(screen.getByTestId("lead-provider-select")).toBeInTheDocument()
    })
  })

  it("renders the dialog header keyed by teammate name", () => {
    render(
      <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={teammate} team={team} />
    )
    expect(screen.getByText(/title:/)).toBeInTheDocument()
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
  })

  it("mounts without throwing when team has no capability default pool", () => {
    expect(() =>
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={teammate} team={team} />
      )
    ).not.toThrow()
  })

  describe("roster twin binding", () => {
    it("offers a None option plus every live twin", () => {
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={teammate} team={team} />
      )
      fireEvent.click(getTwinSelectTrigger())
      const listbox = screen.getByRole("listbox")
      expect(within(listbox).getByText("rosterSection.twinNone")).toBeInTheDocument()
      expect(within(listbox).getByText("Alice")).toBeInTheDocument()
      expect(within(listbox).getByText("Bob")).toBeInTheDocument()
    })

    it("selecting a twin writes it onto config.twinId", () => {
      render(
        <TeammateConfigDialog open={true} onOpenChange={() => {}} teammate={teammate} team={team} />
      )
      fireEvent.click(getTwinSelectTrigger())
      fireEvent.click(within(screen.getByRole("listbox")).getByText("Bob"))
      expect(updateTeammateMock).toHaveBeenCalledWith("t1", { config: { twinId: "tw2" } })
    })

    it('selecting "None" clears an existing twinId', () => {
      const boundTeammate: AgentTeammate = { ...teammate, config: { twinId: "tw1" } }
      render(
        <TeammateConfigDialog
          open={true}
          onOpenChange={() => {}}
          teammate={boundTeammate}
          team={team}
        />
      )
      fireEvent.click(getTwinSelectTrigger())
      fireEvent.click(within(screen.getByRole("listbox")).getByText("rosterSection.twinNone"))
      expect(updateTeammateMock).toHaveBeenCalledWith("t1", { config: { twinId: undefined } })
    })
  })
})
