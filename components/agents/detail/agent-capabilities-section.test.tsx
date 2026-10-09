/** @jest-environment jsdom */

// What an agent can reach, read back in words (ADR-0220): ids resolved to
// names, missing ones flagged, defaults spelled out, only overridden powers.

import { fireEvent, render, screen, within } from "@testing-library/react"

import type { Character } from "@cognia/agent-config-types"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"

const mockPluginSkills = new Map<string, { name: string }>()
jest.mock("@/hooks/skills/use-plugin-skills", () => ({
  usePluginSkillsById: () => mockPluginSkills,
}))

import { AgentCapabilitiesSection } from "./agent-capabilities-section"

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Character
}

const catalogs = {
  skills: [{ id: "sk_1", name: "Summarize" }],
  mcpServers: [{ id: "mcp_1", name: "GitHub" }],
  knowledgeBases: [{ id: "kb_1", name: "Handbook" }],
} as unknown as AgentCatalogs

/** The `<dd>` of the row whose term reads `label`. */
function row(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" })
  return term.nextElementSibling as HTMLElement
}

beforeEach(() => mockPluginSkills.clear())

describe("AgentCapabilitiesSection", () => {
  it("spells out every default for an agent that sets nothing", () => {
    render(<AgentCapabilitiesSection agent={agent()} catalogs={catalogs} />)
    expect(row("Skills")).toHaveTextContent("None")
    expect(row("MCP servers")).toHaveTextContent("Every enabled MCP server")
    expect(row("Knowledge bases")).toHaveTextContent("None")
    expect(row("Allowed tools")).toHaveTextContent("No limit")
    expect(row("Denied tools")).toHaveTextContent("None")
    expect(row("Built-in capabilities")).toHaveTextContent("App default")
    expect(row("Memory")).toHaveTextContent("Follows the app's memory settings.")
  })

  it("says None (not every server) for an explicitly empty MCP subset", () => {
    render(<AgentCapabilitiesSection agent={agent({ mcpServerIds: [] })} catalogs={catalogs} />)
    expect(row("MCP servers")).toHaveTextContent("None")
  })

  it("resolves skills, plugin skills, servers and knowledge bases to names and flags missing ids", () => {
    mockPluginSkills.set("plugin:p/s", { name: "Plugin Skill" })
    render(
      <AgentCapabilitiesSection
        agent={agent({
          skillIds: ["sk_1", "sk_gone"],
          pluginSkillIds: ["plugin:p/s"],
          mcpServerIds: ["mcp_1"],
          knowledgeBaseIds: ["kb_1"],
        })}
        catalogs={catalogs}
      />
    )
    const skills = row("Skills")
    expect(within(skills).getByText("Summarize")).toBeInTheDocument()
    expect(within(skills).getByText("Plugin Skill")).toBeInTheDocument()
    const missing = within(skills).getByText("sk_gone")
    expect(missing).toHaveAttribute("title", "Not available on this device")
    expect(within(skills).getByText("Summarize")).not.toHaveAttribute("title")
    expect(row("MCP servers")).toHaveTextContent("GitHub")
    expect(row("Knowledge bases")).toHaveTextContent("Handbook")
  })

  it("lists allowed and denied tools in a monospace face", () => {
    render(
      <AgentCapabilitiesSection
        agent={agent({ allowedTools: ["Read", "Grep"], disallowedTools: ["Bash"] })}
        catalogs={catalogs}
      />
    )
    expect(row("Allowed tools")).toHaveTextContent("Read, Grep")
    expect(row("Allowed tools")).toHaveClass("font-mono")
    expect(row("Denied tools")).toHaveTextContent("Bash")
    expect(row("Denied tools")).toHaveClass("font-mono")
  })

  it("shows only the powers the agent overrides, striking the ones it turns off", () => {
    render(
      <AgentCapabilitiesSection
        agent={agent({ enableComputerUse: true, sandboxEnabled: false })}
        catalogs={catalogs}
      />
    )
    expect(screen.getByTestId("agent-power-computerUse")).toHaveTextContent("Computer use")
    expect(screen.getByTestId("agent-power-computerUse")).not.toHaveClass("line-through")
    expect(screen.getByTestId("agent-power-sandbox")).toHaveClass("line-through")
    expect(screen.queryByTestId("agent-power-ocr")).not.toBeInTheDocument()
    expect(row("Built-in capabilities")).not.toHaveTextContent("App default")
  })

  it("reads a memory policy back as operations and a summary", () => {
    render(
      <AgentCapabilitiesSection
        agent={agent({
          memoryPolicy: {
            operations: { recall: true, create: true, update: false, forget: false },
            readableScopes: ["global", "agent"],
            writableScopes: [],
            autoLearn: true,
          },
        })}
        catalogs={catalogs}
      />
    )
    const memory = row("Memory")
    expect(within(memory).getByText("Recall")).not.toHaveClass("line-through")
    expect(within(memory).getByText("Forget")).toHaveClass("line-through")
    expect(memory).toHaveTextContent("Reads global, agent · writes None · auto-learn On")
  })

  it("offers Edit only when the caller can edit in place", () => {
    const onEdit = jest.fn()
    const { rerender } = render(<AgentCapabilitiesSection agent={agent()} catalogs={catalogs} />)
    expect(screen.queryByTestId("agent-capabilities-edit")).not.toBeInTheDocument()
    rerender(<AgentCapabilitiesSection agent={agent()} catalogs={catalogs} onEdit={onEdit} />)
    fireEvent.click(screen.getByTestId("agent-capabilities-edit"))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})
