/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { EntityPicker, TeamPicker } from "./entity-picker"

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({
  listTeams: jest.fn(async () => [{ id: "team_1", name: "Alpha" }]),
}))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))

const messages = {
  workflows: {
    forms: {
      pickers: {
        team: "Select a team",
        none: "None",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
]

describe("EntityPicker", () => {
  it("renders the combobox with the placeholder when nothing is selected", () => {
    wrap(
      <EntityPicker
        id="ep"
        value=""
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="Pick one"
      />
    )
    expect(screen.getByLabelText("Pick one")).toBeInTheDocument()
  })

  it("shows the selected option's label, not its raw id", () => {
    wrap(
      <EntityPicker
        id="ep"
        value="b"
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="Pick one"
      />
    )
    // The combobox input placeholder reflects the resolved label.
    expect(screen.getByLabelText("Pick one")).toHaveAttribute("placeholder", "Beta")
  })

  it("toggles into expression mode and edits a raw value", () => {
    const onChange = jest.fn()
    wrap(
      <EntityPicker
        id="ep"
        value=""
        onChange={onChange}
        options={OPTIONS}
        placeholder="Pick one"
        allowExpression
      />
    )
    fireEvent.click(screen.getByTestId("ep-use-expression"))
    const input = screen.getByLabelText("Pick one")
    fireEvent.change(input, { target: { value: "{{ $node['x'].out.id }}" } })
    expect(onChange).toHaveBeenCalledWith("{{ $node['x'].out.id }}")
    // And we can switch back to the picker.
    fireEvent.click(screen.getByTestId("ep-use-picker"))
    expect(screen.queryByTestId("ep-use-picker")).not.toBeInTheDocument()
  })

  it("starts in expression mode when the value already holds an expression", () => {
    wrap(
      <EntityPicker
        id="ep"
        value="{{ $vars.team }}"
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="Pick one"
        allowExpression
      />
    )
    // Manual mode renders a font-mono Input pre-filled with the expression.
    expect(screen.getByDisplayValue("{{ $vars.team }}")).toBeInTheDocument()
    expect(screen.getByTestId("ep-use-picker")).toBeInTheDocument()
  })

  it("does not offer the expression toggle when allowExpression is false", () => {
    wrap(<EntityPicker id="ep" value="" onChange={jest.fn()} options={OPTIONS} />)
    expect(screen.queryByTestId("ep-use-expression")).not.toBeInTheDocument()
  })
})

describe("entity wrappers", () => {
  it("TeamPicker loads teams from Dexie and renders the picker", async () => {
    wrap(<TeamPicker id="tp" value="" onChange={jest.fn()} />)
    expect(await screen.findByLabelText("Select a team")).toBeInTheDocument()
  })
})
