/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { Character } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

let mockAgents: Character[] | undefined = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockAgents }))
jest.mock("@/lib/db/characters", () => ({ listResolvedCharacters: jest.fn() }))

import { WorkspaceDefaultAgentField } from "./workspace-default-agent-field"

const reviewer = { id: "char_reviewer", name: "Reviewer" } as Character
const strict = {
  id: "char_strict",
  name: "Reviewer (strict)",
  variant: { baseId: "char_reviewer", ownFields: ["model"] },
} as Character

beforeEach(() => {
  mockAgents = [reviewer, strict]
})

describe("WorkspaceDefaultAgentField", () => {
  it("reads none when the workspace has no default", () => {
    render(<WorkspaceDefaultAgentField value="" onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "defaultAgentLabel" })).toHaveTextContent(
      "defaultAgentNone"
    )
    expect(screen.getByTestId("workspace-default-agent-hint")).toHaveTextContent("defaultAgentHint")
  })

  it("shows the chosen agent, variants included", () => {
    render(<WorkspaceDefaultAgentField value="char_strict" onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "defaultAgentLabel" })).toHaveTextContent(
      "Reviewer (strict)"
    )
  })

  it("picks an agent and clears back to none", () => {
    const onChange = jest.fn()
    const { rerender } = render(<WorkspaceDefaultAgentField value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole("combobox", { name: "defaultAgentLabel" }))
    fireEvent.click(screen.getByRole("option", { name: "Reviewer" }))
    expect(onChange).toHaveBeenLastCalledWith("char_reviewer")

    rerender(<WorkspaceDefaultAgentField value="char_reviewer" onChange={onChange} />)
    fireEvent.click(screen.getByRole("combobox", { name: "defaultAgentLabel" }))
    fireEvent.click(screen.getByRole("option", { name: "defaultAgentNone" }))
    expect(onChange).toHaveBeenLastCalledWith("")
  })

  it("keeps a default that no longer resolves visible as missing", () => {
    render(<WorkspaceDefaultAgentField value="char_gone" onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "defaultAgentLabel" })).toHaveTextContent(
      'defaultAgentMissing:{"id":"char_gone"}'
    )
    expect(screen.getByTestId("workspace-default-agent-hint")).toHaveTextContent(
      "defaultAgentMissingHint"
    )
  })

  it("does not call a default missing while the list is still loading", () => {
    mockAgents = undefined
    render(<WorkspaceDefaultAgentField value="char_reviewer" onChange={jest.fn()} />)
    expect(screen.getByTestId("workspace-default-agent-hint")).toHaveTextContent("defaultAgentHint")
  })
})
