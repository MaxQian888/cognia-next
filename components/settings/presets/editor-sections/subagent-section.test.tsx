/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/claude/agents/subagents", () => ({
  resolveAllSubagents: jest.fn(),
}))

import { resolveAllSubagents } from "@/lib/claude/agents/subagents"
import { SubagentSection } from "./subagent-section"
import { emptyEditorState } from "../preset-editor-state"

function renderSection(initialIds?: string[]) {
  const onPatch = jest.fn()
  const utils = render(
    <SubagentSection
      state={{ ...emptyEditorState(), subagentIds: initialIds }}
      onPatch={onPatch}
      defaultOpen={true}
    />
  )
  return { ...utils, onPatch }
}

describe("SubagentSection", () => {
  beforeEach(() => {
    ;(resolveAllSubagents as jest.Mock).mockReset()
  })

  it("renders an empty hint when no subagents are available", () => {
    ;(resolveAllSubagents as jest.Mock).mockReturnValue({})
    renderSection()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("labels built-in vs plugin subagents distinctly", () => {
    ;(resolveAllSubagents as jest.Mock).mockReturnValue({
      "workflow-designer": { description: "designs workflows" },
      "myPlugin:reviewer": { description: "reviews things" },
    })
    renderSection()
    expect(screen.getByText("workflow-designer")).toBeInTheDocument()
    expect(screen.getByText("myPlugin:reviewer")).toBeInTheDocument()
    expect(screen.getByText("builtinBadge")).toBeInTheDocument()
    expect(screen.getByText("pluginBadge")).toBeInTheDocument()
  })

  it("toggle dispatches the merged id list to onPatch", () => {
    ;(resolveAllSubagents as jest.Mock).mockReturnValue({
      "workflow-designer": { description: "" },
    })
    const { onPatch } = renderSection()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onPatch).toHaveBeenCalledWith({ subagentIds: ["workflow-designer"] })
  })
})
