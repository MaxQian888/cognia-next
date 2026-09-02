/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { SquadDeriveActions } from "./squad-derive-actions"
import type { TemplateRuntime } from "@/lib/templates/runtime"
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
        publishOption: "Publish it as a version too",
        publishOptionHint: "Only a published version can be bundled into a package.",
        templatePublished: "Published {name} v{version}.",
        publishFailed: "Could not publish: {error}",
      },
    },
  },
  templateStudio: {
    publishDialog: {
      title: "Publish a version",
      description: "{current} to {next}",
      unreleased: "unreleased",
      bump: { major: "Major", minor: "Minor", patch: "Patch" },
      noReasons: "No reasons",
      cancel: "Cancel",
      confirm: "Publish {version}",
    },
  },
}

/**
 * A stub rather than the production runtime: `getTemplateRuntime()` opens
 * Dexie, and what this suite is about is the order of the calls, not storage.
 */
function makeRuntime() {
  const drafts = new Map<string, { id: string; revision: number }>()
  const publish = jest.fn(async () => ({ version: "0.1.0" }))
  const getPublishSuggestion = jest.fn(async () => ({
    bump: "minor" as const,
    reasons: ["Initial release"],
    currentVersion: null,
    nextVersion: "0.1.0",
  }))
  const runtime = {
    catalog: {} as TemplateRuntime["catalog"],
    repository: {
      getDraft: async (id: string) => drafts.get(id),
    } as unknown as TemplateRuntime["repository"],
    service: {
      createDraft: async (input: { id: string }) => {
        drafts.set(input.id, { id: input.id, revision: 1 })
        return input
      },
      saveDraft: async () => undefined,
      getPublishSuggestion,
      publish,
    } as unknown as TemplateRuntime["service"],
  } as TemplateRuntime
  return { runtime, publish, getPublishSuggestion, drafts }
}

function renderActions(
  squadId: string,
  options: { onDuplicated?: (id: string) => void; runtime?: TemplateRuntime } = {}
) {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SquadDeriveActions
        squadId={squadId}
        {...(options.onDuplicated ? { onDuplicated: options.onDuplicated } : {})}
        {...(options.runtime ? { runtime: options.runtime } : {})}
      />
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
    renderActions(squadId, { onDuplicated })
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
  it("saves the squad as a template", async () => {
    const { runtime } = makeRuntime()
    renderActions(squadId, { runtime })
    fireEvent.click(screen.getByTestId("squad-save-as-template"))
    // The version step is the point of the option, so this case turns it off.
    fireEvent.click(screen.getByTestId("squad-template-publish-toggle"))
    fireEvent.click(screen.getByTestId("squad-save-as-template-confirm"))

    const templates = Object.values(useAgentTeamStore.getState().templates)
    expect(templates.some((tpl) => tpl.name === "Alpha")).toBe(true)
    await waitFor(() =>
      expect(screen.getByTestId("squad-derive-message")).toHaveTextContent("Alpha")
    )
    expect(screen.queryByTestId("template-publish-dialog")).not.toBeInTheDocument()
  })

  /**
   * A saved template is a platform DRAFT, and a draft cannot be packaged,
   * forked, or handed to anyone. The dialog offers the release in the same
   * step, through the service's own suggestion rather than a version this
   * component picks.
   */
  it("offers the version the service suggests, and publishes the confirmed bump", async () => {
    const { runtime, publish, getPublishSuggestion } = makeRuntime()
    renderActions(squadId, { runtime })
    fireEvent.click(screen.getByTestId("squad-save-as-template"))
    fireEvent.click(screen.getByTestId("squad-save-as-template-confirm"))

    await waitFor(() => expect(getPublishSuggestion).toHaveBeenCalled())
    const confirm = await screen.findByTestId("template-publish-confirm")
    expect(confirm).toHaveTextContent("0.1.0")
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(expect.stringContaining("legacy.agentTeam."), {
        expectedRevision: 1,
        confirmedBump: "minor",
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId("squad-derive-message")).toHaveTextContent("0.1.0")
    )
  })

  it("reports a refused publish instead of leaving the dialog stuck", async () => {
    const { runtime, publish } = makeRuntime()
    publish.mockRejectedValueOnce(new Error("draft changed before publication"))
    renderActions(squadId, { runtime })
    fireEvent.click(screen.getByTestId("squad-save-as-template"))
    fireEvent.click(screen.getByTestId("squad-save-as-template-confirm"))
    fireEvent.click(await screen.findByTestId("template-publish-confirm"))

    await waitFor(() =>
      expect(screen.getByTestId("squad-derive-message")).toHaveTextContent(
        "draft changed before publication"
      )
    )
  })

  it("will not create something with no name", () => {
    renderActions(squadId)
    fireEvent.click(screen.getByTestId("squad-duplicate"))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } })
    expect(screen.getByTestId("squad-duplicate-confirm")).toBeDisabled()
  })
})
