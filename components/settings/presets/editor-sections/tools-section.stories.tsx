import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { ToolsSection } from "./tools-section"
import { emptyEditorState, type PresetEditorState } from "../preset-editor-state"
import type { McpServer, Skill } from "@cognia/agent-config-types"

// Tools section: allow/deny tool lists + skill + MCP-server multi-selects.
// Controlled via `state` + `onPatch`, with skill/MCP catalogs supplied by the
// parent.
const skills: Skill[] = [
  { id: "skill-research", name: "Deep research", description: "Multi-source research" } as Skill,
  { id: "skill-format", name: "Code formatter", description: "Format on save" } as Skill,
]
const mcps: McpServer[] = [
  { id: "mcp-github", name: "GitHub" } as McpServer,
  { id: "mcp-fs", name: "Filesystem" } as McpServer,
]

function Harness({ initial, catalogs }: { initial: PresetEditorState; catalogs: boolean }) {
  const [state, setState] = useState(initial)
  return (
    <div className="max-w-2xl">
      <ToolsSection
        state={state}
        onPatch={(patch) => setState((prev) => ({ ...prev, ...patch }))}
        skillsCatalog={catalogs ? skills : []}
        mcpCatalog={catalogs ? mcps : []}
        defaultOpen
      />
    </div>
  )
}

const meta = {
  title: "Settings/Presets/EditorSections/ToolsSection",
  component: ToolsSection,
  parameters: { layout: "padded" },
  args: { state: emptyEditorState(), onPatch: fn(), skillsCatalog: [], mcpCatalog: [] },
} satisfies Meta<typeof ToolsSection>

export default meta
type Story = StoryObj<typeof meta>

// Catalogs populated → skill + MCP multi-selects list options.
export const WithCatalogs: Story = {
  render: () => <Harness initial={emptyEditorState()} catalogs />,
}

// Empty catalogs → multi-selects show their empty hints.
export const EmptyCatalogs: Story = {
  render: () => <Harness initial={emptyEditorState()} catalogs={false} />,
}
