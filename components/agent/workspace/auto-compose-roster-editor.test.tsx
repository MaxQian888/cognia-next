/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { AutoComposeRosterEditor } from "./auto-compose-roster-editor"
import type { CapabilityCatalog, ProposedTeammate } from "@/lib/ai/agent/team/auto/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const EMPTY_CATALOG: CapabilityCatalog = {
  skillIds: [],
  mcpServerIds: [],
  nativeAnthropicToolIds: [],
  characterPackIds: [],
  externalAgentPresetIds: [],
  subagentIds: [],
}

const roster = (): ProposedTeammate[] => [
  { name: "Lead", role: "lead", description: "coordinates" },
  { name: "Worker", role: "teammate", description: "does work", specialization: "bugs" },
]

function setup(catalog: CapabilityCatalog = EMPTY_CATALOG, members = roster()) {
  const onChange = jest.fn()
  const onAdd = jest.fn()
  const onRemove = jest.fn()
  const onSetLead = jest.fn()
  render(
    <AutoComposeRosterEditor
      roster={members}
      catalog={catalog}
      onChange={onChange}
      onAdd={onAdd}
      onRemove={onRemove}
      onSetLead={onSetLead}
    />
  )
  return { onChange, onAdd, onRemove, onSetLead }
}

describe("AutoComposeRosterEditor", () => {
  it("renders one card per member with the lead badge on index 0", () => {
    setup()
    expect(screen.getByTestId("auto-compose-member-0")).toBeInTheDocument()
    expect(screen.getByTestId("auto-compose-member-1")).toBeInTheDocument()
    // Lead has no 'set as lead' button; the teammate does.
    expect(screen.queryByTestId("auto-compose-set-lead-0")).not.toBeInTheDocument()
    expect(screen.getByTestId("auto-compose-set-lead-1")).toBeInTheDocument()
  })

  it("reports field edits immutably", () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByTestId("auto-compose-member-name-1"), {
      target: { value: "Renamed" },
    })
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Lead" }),
      expect.objectContaining({ name: "Renamed" }),
    ])
  })

  it("clears specialization back to undefined when emptied", () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByTestId("auto-compose-member-spec-1"), { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith([
      expect.anything(),
      expect.objectContaining({ specialization: undefined }),
    ])
  })

  it("delegates structural ops to the dialog", () => {
    const { onAdd, onRemove, onSetLead } = setup()
    fireEvent.click(screen.getByTestId("auto-compose-add-member"))
    expect(onAdd).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("auto-compose-remove-member-1"))
    expect(onRemove).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTestId("auto-compose-set-lead-1"))
    expect(onSetLead).toHaveBeenCalledWith(1)
  })

  it("disables removal when only one member remains", () => {
    setup(EMPTY_CATALOG, [{ name: "Solo", role: "lead", description: "alone" }])
    expect(screen.getByTestId("auto-compose-remove-member-0")).toBeDisabled()
  })

  it("offers only catalog-backed capabilities and toggles them as add overlays", () => {
    const catalog: CapabilityCatalog = { ...EMPTY_CATALOG, skillIds: ["web-research", "ocr"] }
    const { onChange } = setup(catalog)
    const chip = screen.getByTestId("auto-compose-cap-1-skillIds-web-research")
    expect(chip).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Lead" }),
      expect.objectContaining({ capabilities: { skillIds: { add: ["web-research"] } } }),
    ])
  })

  it("removes a capability bucket when its last id is toggled off", () => {
    const catalog: CapabilityCatalog = { ...EMPTY_CATALOG, skillIds: ["web-research"] }
    const members: ProposedTeammate[] = [
      { name: "Lead", role: "lead", description: "l" },
      {
        name: "Worker",
        role: "teammate",
        description: "w",
        capabilities: { skillIds: { add: ["web-research"] } },
      },
    ]
    const { onChange } = setup(catalog, members)
    const chip = screen.getByTestId("auto-compose-cap-1-skillIds-web-research")
    expect(chip).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith([
      expect.anything(),
      expect.objectContaining({ capabilities: undefined }),
    ])
  })

  it("renders no capability section when the catalog is empty", () => {
    setup()
    expect(screen.queryByText("capabilitiesLabel")).not.toBeInTheDocument()
  })
})
