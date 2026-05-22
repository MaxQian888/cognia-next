/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn() }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn() }))

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
}))

const updateTeammateMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({ updateTeammate: updateTeammateMock }),
}))

import { TeammateConfigDialog } from "./teammate-config-dialog"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

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

describe("TeammateConfigDialog", () => {
  beforeEach(() => updateTeammateMock.mockReset())

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
})
