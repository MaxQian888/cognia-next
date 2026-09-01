/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { SquadDeriveActions } from "./squad-derive-actions"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"

const messages = {
  settings: {
    squads: {
      derive: {
        title: "Reuse this squad",
        description: "Copy it into a workspace, or save its shape as a template.",
        duplicate: "Duplicate",
        duplicateTitle: "Duplicate this squad",
        duplicateBody: "The roster comes across.",
        copyDefaultName: "{name} copy",
        duplicated: "Created {name}.",
        saveAsTemplate: "Save as template",
        templateTitle: "Save as a template",
        templateBody: "A template keeps the roster shape.",
        templateSaved: "Saved {name} to your templates.",
        nameLabel: "Name",
        workspaceLabel: "Workspace",
        cancel: "Cancel",
      },
    },
  },
}

function renderActions(squadId: string, onDuplicated?: (id: string) => void) {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SquadDeriveActions squadId={squadId} {...(onDuplicated ? { onDuplicated } : {})} />
    </NextIntlClientProvider>
  )
}

describe("SquadDeriveActions", () => {
  let squadId = ""

  beforeEach(() => {
    useAgentTeamStore.setState({ teams: {}, teammates: {}, tasks: {}, templates: {} })
    useProjectStore.setState({
      projects: [
        { id: "ws_1", name: "Work" },
        { id: "ws_2", name: "Side" },
      ] as never,
      activeProjectId: "ws_1",
    } as never)
    squadId = useAgentTeamStore.getState().createTeam({ name: "Alpha", task: "ship" }).id
  })

  it("renders nothing for a squad that is not there", () => {
    renderActions("missing")
    expect(screen.queryByTestId("squad-derive")).toBeNull()
  })

  it("duplicates the squad under the name given", () => {
    const onDuplicated = jest.fn()
    renderActions(squadId, onDuplicated)
    fireEvent.click(screen.getByTestId("squad-duplicate"))
    fireEvent.click(screen.getByTestId("squad-duplicate-confirm"))

    const names = Object.values(useAgentTeamStore.getState().teams).map((t) => t.name)
    expect(names).toContain("Alpha copy")
    expect(onDuplicated).toHaveBeenCalled()
  })

  /**
   * The reason this dialog offers a workspace at all: `projectId` is a real
   * storage boundary from schema v215, so this moves the copy rather than
   * relabelling it.
   */
  it("copies into the workspace the user picked", () => {
    renderActions(squadId)
    fireEvent.click(screen.getByTestId("squad-duplicate"))
    fireEvent.click(screen.getByTestId("squad-duplicate-confirm"))

    const copy = Object.values(useAgentTeamStore.getState().teams).find(
      (t) => t.name === "Alpha copy"
    )
    expect(copy?.projectId).toBe("ws_1")
  })

  /** `saveAsTemplate` shipped with no caller at all before this. */
  it("saves the squad as a template", () => {
    renderActions(squadId)
    fireEvent.click(screen.getByTestId("squad-save-as-template"))
    fireEvent.click(screen.getByTestId("squad-save-as-template-confirm"))

    const templates = Object.values(useAgentTeamStore.getState().templates)
    expect(templates.some((tpl) => tpl.name === "Alpha")).toBe(true)
    expect(screen.getByTestId("squad-derive-message")).toHaveTextContent("Alpha")
  })

  it("will not create something with no name", () => {
    renderActions(squadId)
    fireEvent.click(screen.getByTestId("squad-duplicate"))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } })
    expect(screen.getByTestId("squad-duplicate-confirm")).toBeDisabled()
  })
})
