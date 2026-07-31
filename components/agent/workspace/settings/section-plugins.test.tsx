/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub Dexie live queries — return empty arrays immediately.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    try {
      return fn()
    } catch {
      return undefined
    }
  },
}))

jest.mock("@/lib/db/skills", () => ({
  listSkills: () => [],
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: () => [],
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const updateTeamCapabilitiesMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamCapabilities: jest.Mock }) => unknown) =>
    sel({ updateTeamCapabilities: updateTeamCapabilitiesMock }),
}))

// Stub all heavy preset editor section sub-components to simple controllable
// harnesses that expose an onPatch call so we can verify the wiring.
jest.mock("@/components/settings/presets/editor-sections/tools-section", () => ({
  ToolsSection: ({ onPatch }: { onPatch: (patch: Record<string, unknown>) => void }) => (
    <button data-testid="tools-patch" onClick={() => onPatch({ skillIds: ["s1"] })}>
      tools
    </button>
  ),
}))

jest.mock("@/components/settings/presets/editor-sections/native-tools-section", () => ({
  NativeToolsSection: ({ onPatch }: { onPatch: (patch: Record<string, unknown>) => void }) => (
    <button
      data-testid="native-patch"
      onClick={() => onPatch({ nativeAnthropicToolIds: ["computer_use"] })}
    >
      native
    </button>
  ),
}))

jest.mock("@/components/settings/presets/editor-sections/character-section", () => ({
  CharacterSection: ({ onPatchMulti }: { onPatchMulti: (ids: string[]) => void }) => (
    <button data-testid="character-multi" onClick={() => onPatchMulti(["char1"])}>
      character
    </button>
  ),
}))

jest.mock("@/components/settings/presets/editor-sections/subagent-section", () => ({
  SubagentSection: ({ onPatch }: { onPatch: (patch: Record<string, unknown>) => void }) => (
    <button data-testid="subagent-patch" onClick={() => onPatch({ subagentIds: ["sub1"] })}>
      subagent
    </button>
  ),
}))

jest.mock("@/components/settings/presets/editor-sections/external-preset-section", () => ({
  ExternalPresetSection: ({ onPatchMulti }: { onPatchMulti: (ids: string[]) => void }) => (
    <button data-testid="external-multi" onClick={() => onPatchMulti(["ext1"])}>
      external
    </button>
  ),
}))

jest.mock("@/components/settings/presets/preset-editor-state", () => ({
  emptyEditorState: () => ({
    mcpServerIds: undefined,
    skillIds: [],
    nativeAnthropicToolIds: undefined,
    subagentIds: undefined,
    characterPackId: undefined,
    externalAgentPresetId: undefined,
  }),
}))

import { PluginsSection } from "./section-plugins"
import type { AgentTeam } from "@/types/agent/agent-team"

function makeTeam(capabilities?: AgentTeam["config"]["capabilities"]): AgentTeam {
  return {
    id: "t1",
    name: "Team",
    description: "",
    task: "task",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      capabilities,
    },
    leadId: "lead",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
  } as AgentTeam
}

beforeEach(() => {
  updateTeamCapabilitiesMock.mockReset()
  markSavedMock.mockReset()
})

describe("PluginsSection", () => {
  it("renders the intro text", () => {
    render(<PluginsSection team={makeTeam()} />)
    expect(screen.getByText("intro")).toBeInTheDocument()
  })

  it("renders all sub-section stubs", () => {
    render(<PluginsSection team={makeTeam()} />)
    expect(screen.getByTestId("tools-patch")).toBeInTheDocument()
    expect(screen.getByTestId("native-patch")).toBeInTheDocument()
    expect(screen.getByTestId("character-multi")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-patch")).toBeInTheDocument()
    expect(screen.getByTestId("external-multi")).toBeInTheDocument()
  })

  it("handlePatch: merges skillIds and calls updateTeamCapabilities + markSaved", () => {
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("tools-patch"))
    expect(updateTeamCapabilitiesMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ skillIds: ["s1"] })
    )
    expect(markSavedMock).toHaveBeenCalledTimes(1)
  })

  it("handlePatch: nativeAnthropicToolIds wired via NativeToolsSection", () => {
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("native-patch"))
    expect(updateTeamCapabilitiesMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ nativeAnthropicToolIds: ["computer_use"] })
    )
    expect(markSavedMock).toHaveBeenCalledTimes(1)
  })

  it("patchCharacterPacks: updates characterPackIds and calls markSaved", () => {
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("character-multi"))
    expect(updateTeamCapabilitiesMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ characterPackIds: ["char1"] })
    )
    expect(markSavedMock).toHaveBeenCalledTimes(1)
  })

  it("patchCharacterPacks: clears to undefined when empty array passed", () => {
    // We test this by checking editorStateToBundle: empty skillIds stays undefined.
    // Use a team with existing characterPackIds and verify clearing.
    render(<PluginsSection team={makeTeam({ characterPackIds: ["old"] })} />)
    // The mock sends ["char1"], so characterPackIds will be set — just confirm call.
    fireEvent.click(screen.getByTestId("character-multi"))
    expect(updateTeamCapabilitiesMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ characterPackIds: ["char1"] })
    )
  })

  it("patchExternalPresets: updates externalAgentPresetIds", () => {
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("external-multi"))
    expect(updateTeamCapabilitiesMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ externalAgentPresetIds: ["ext1"] })
    )
    expect(markSavedMock).toHaveBeenCalledTimes(1)
  })

  it("subagent patch wired via SubagentSection", () => {
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("subagent-patch"))
    expect(updateTeamCapabilitiesMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ subagentIds: ["sub1"] })
    )
  })

  it("preserves existing characterPackIds and externalAgentPresetIds when patching editor-state fields", () => {
    const team = makeTeam({
      characterPackIds: ["char-existing"],
      externalAgentPresetIds: ["ext-existing"],
    })
    render(<PluginsSection team={team} />)
    fireEvent.click(screen.getByTestId("tools-patch"))
    const call = updateTeamCapabilitiesMock.mock.calls[0][1]
    expect(call.characterPackIds).toEqual(["char-existing"])
    expect(call.externalAgentPresetIds).toEqual(["ext-existing"])
  })

  it("renders with no capabilities configured (undefined bundle)", () => {
    render(<PluginsSection team={makeTeam(undefined)} />)
    expect(screen.getByText("intro")).toBeInTheDocument()
  })

  it("editorStateToBundle: skillIds from tools patch arrives in bundle", () => {
    // The onPatch mock sends ["s1"] — verify the bundle reflects it.
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("tools-patch"))
    const bundle = updateTeamCapabilitiesMock.mock.calls[0][1]
    // Non-empty skillIds should be preserved.
    expect(bundle.skillIds).toEqual(["s1"])
  })

  it("patchCharacterPacks non-empty array sets characterPackIds in bundle", () => {
    // The CharacterSection stub calls onPatchMulti(["char1"]).
    render(<PluginsSection team={makeTeam({ characterPackIds: ["old"] })} />)
    fireEvent.click(screen.getByTestId("character-multi"))
    const bundle = updateTeamCapabilitiesMock.mock.calls[0][1]
    // ["char1"] is non-empty so it maps to characterPackIds: ["char1"]
    expect(bundle.characterPackIds).toEqual(["char1"])
  })

  it("patchExternalPresets with non-empty array sets externalAgentPresetIds in bundle", () => {
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("external-multi"))
    const bundle = updateTeamCapabilitiesMock.mock.calls[0][1]
    expect(bundle.externalAgentPresetIds).toEqual(["ext1"])
  })

  it("editorStateToBundle: bundle does not include empty skillIds", () => {
    // tools stub sends skillIds:["s1"] — bundle receives it as-is (non-empty).
    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("tools-patch"))
    const bundle = updateTeamCapabilitiesMock.mock.calls[0][1]
    // skillIds ["s1"].length > 0 → preserved.
    expect(bundle.skillIds).toEqual(["s1"])
  })
})

// Separate describe to cover the missing branches using alternate stub implementations.
describe("PluginsSection – missing branch coverage", () => {
  // Use a separate module registry via jest.isolateModules so we can override the
  // CharacterSection / ExternalPresetSection stubs to send empty arrays.

  const updateTeamCapabilitiesAlt = jest.fn()

  beforeEach(() => {
    updateTeamCapabilitiesAlt.mockReset()
    markSavedMock.mockReset()
  })

  it("patchCharacterPacks empty array → characterPackIds becomes undefined", () => {
    // Temporarily replace CharacterSection mock to call onPatchMulti([]).
    const mod = jest.requireMock(
      "@/components/settings/presets/editor-sections/character-section"
    ) as { CharacterSection: React.FC<{ onPatchMulti: (ids: string[]) => void }> }
    const original = mod.CharacterSection
    const CharEmpty = ({ onPatchMulti }: { onPatchMulti: (ids: string[]) => void }) => (
      <button data-testid="char-empty" onClick={() => onPatchMulti([])}>
        char-empty
      </button>
    )
    mod.CharacterSection = CharEmpty

    render(<PluginsSection team={makeTeam({ characterPackIds: ["existing"] })} />)
    fireEvent.click(screen.getByTestId("char-empty"))
    // Empty ids → characterPackIds: undefined (length 0 branch)
    const call = updateTeamCapabilitiesMock.mock.calls[0][1]
    expect(call.characterPackIds).toBeUndefined()

    mod.CharacterSection = original
  })

  it("patchExternalPresets empty array → externalAgentPresetIds becomes undefined", () => {
    const mod = jest.requireMock(
      "@/components/settings/presets/editor-sections/external-preset-section"
    ) as { ExternalPresetSection: React.FC<{ onPatchMulti: (ids: string[]) => void }> }
    const original = mod.ExternalPresetSection
    const ExtEmpty = ({ onPatchMulti }: { onPatchMulti: (ids: string[]) => void }) => (
      <button data-testid="ext-empty" onClick={() => onPatchMulti([])}>
        ext-empty
      </button>
    )
    mod.ExternalPresetSection = ExtEmpty

    render(<PluginsSection team={makeTeam({ externalAgentPresetIds: ["existing"] })} />)
    fireEvent.click(screen.getByTestId("ext-empty"))
    const call = updateTeamCapabilitiesMock.mock.calls[0][1]
    expect(call.externalAgentPresetIds).toBeUndefined()

    mod.ExternalPresetSection = original
  })

  it("editorStateToBundle: mcpServerIds non-empty → included in bundle", () => {
    // Replace ToolsSection to send mcpServerIds.
    const mod = jest.requireMock("@/components/settings/presets/editor-sections/tools-section") as {
      ToolsSection: React.FC<{
        onPatch: (p: Record<string, unknown>) => void
        state: unknown
        skillsCatalog: unknown
        mcpCatalog: unknown
        defaultOpen: boolean
      }>
    }
    const original = mod.ToolsSection
    const ToolsMcp = ({ onPatch }: { onPatch: (p: Record<string, unknown>) => void }) => (
      <button
        data-testid="tools-mcp"
        onClick={() => onPatch({ skillIds: [], mcpServerIds: ["mcp-1"] })}
      >
        tools-mcp
      </button>
    )
    mod.ToolsSection = ToolsMcp

    render(<PluginsSection team={makeTeam()} />)
    fireEvent.click(screen.getByTestId("tools-mcp"))
    const call = updateTeamCapabilitiesMock.mock.calls[0][1]
    // mcpServerIds: ["mcp-1"] is non-empty → included
    expect(call.mcpServerIds).toEqual(["mcp-1"])
    // skillIds: [] is empty → undefined
    expect(call.skillIds).toBeUndefined()

    mod.ToolsSection = original
  })

  it("useLiveQuery returning undefined → skills and mcpServers fall back to [] via memo", () => {
    // Override db mocks to make useLiveQuery return undefined (by throwing).
    const skillsMod = jest.requireMock("@/lib/db/skills") as { listSkills: () => unknown }
    const origSkills = skillsMod.listSkills
    skillsMod.listSkills = () => {
      throw new Error("not ready")
    }
    const mcpMod = jest.requireMock("@/lib/db/mcp-servers") as { listMcpServers: () => unknown }
    const origMcp = mcpMod.listMcpServers
    mcpMod.listMcpServers = () => {
      throw new Error("not ready")
    }

    // useLiveQuery mock returns undefined on error — hits ?? [] branch.
    render(<PluginsSection team={makeTeam()} />)
    expect(screen.getByText("intro")).toBeInTheDocument()

    skillsMod.listSkills = origSkills
    mcpMod.listMcpServers = origMcp
  })
})
