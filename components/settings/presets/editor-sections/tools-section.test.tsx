/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ToolsSection } from "./tools-section"
import { emptyEditorState } from "../preset-editor-state"
import type { McpServer, Skill } from "@/lib/claude/types"

const SKILLS: Skill[] = [
  {
    id: "s1",
    name: "Skill One",
    description: "first",
    content: "",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Skill,
  {
    id: "s2",
    name: "Skill Two",
    description: "second",
    content: "",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Skill,
]

const MCP: McpServer[] = [
  {
    id: "m1",
    name: "MCP One",
    transport: "stdio",
    enabled: true,
  } as unknown as McpServer,
]

describe("ToolsSection", () => {
  it("renders allowed/disallowed tool inputs and skill/MCP pickers", () => {
    render(
      <ToolsSection
        state={emptyEditorState()}
        onPatch={jest.fn()}
        skillsCatalog={SKILLS}
        mcpCatalog={MCP}
      />
    )
    expect(screen.getByText("Allowed tools (comma-separated)")).toBeInTheDocument()
    expect(screen.getByText("Disallowed tools (comma-separated)")).toBeInTheDocument()
    expect(screen.getByText("Skills")).toBeInTheDocument()
    expect(screen.getByText("MCP servers")).toBeInTheDocument()
  })

  it("parses comma-separated allowed tools and calls onPatch with the array", () => {
    const onPatch = jest.fn()
    render(
      <ToolsSection
        state={emptyEditorState()}
        onPatch={onPatch}
        skillsCatalog={SKILLS}
        mcpCatalog={MCP}
      />
    )
    fireEvent.change(screen.getByPlaceholderText("Bash, Read, WebSearch"), {
      target: { value: "Bash, Read" },
    })
    expect(onPatch).toHaveBeenCalledWith({ allowedTools: ["Bash", "Read"] })
  })

  it("parses comma-separated disallowed tools and calls onPatch with the array", () => {
    const onPatch = jest.fn()
    render(
      <ToolsSection
        state={emptyEditorState()}
        onPatch={onPatch}
        skillsCatalog={SKILLS}
        mcpCatalog={MCP}
      />
    )
    fireEvent.change(screen.getByPlaceholderText("Bash"), { target: { value: "Bash" } })
    expect(onPatch).toHaveBeenCalledWith({ disallowedTools: ["Bash"] })
  })

  it("strips whitespace and empty entries when parsing", () => {
    const onPatch = jest.fn()
    render(
      <ToolsSection
        state={emptyEditorState()}
        onPatch={onPatch}
        skillsCatalog={SKILLS}
        mcpCatalog={MCP}
      />
    )
    fireEvent.change(screen.getByPlaceholderText("Bash, Read, WebSearch"), {
      target: { value: " Bash ,, Read , " },
    })
    expect(onPatch).toHaveBeenCalledWith({ allowedTools: ["Bash", "Read"] })
  })

  it("invokes onPatch with the skill id when a skill chip is toggled", () => {
    const onPatch = jest.fn()
    render(
      <ToolsSection
        state={emptyEditorState()}
        onPatch={onPatch}
        skillsCatalog={SKILLS}
        mcpCatalog={MCP}
      />
    )
    fireEvent.click(screen.getByText("Skill One"))
    expect(onPatch).toHaveBeenCalledWith({ skillIds: ["s1"] })
  })

  it("invokes onPatch with undefined when MCP selection becomes empty", () => {
    const onPatch = jest.fn()
    const state = { ...emptyEditorState(), mcpServerIds: ["m1"] }
    render(<ToolsSection state={state} onPatch={onPatch} skillsCatalog={SKILLS} mcpCatalog={MCP} />)
    fireEvent.click(screen.getByText("MCP One"))
    expect(onPatch).toHaveBeenCalledWith({ mcpServerIds: undefined })
  })
})
