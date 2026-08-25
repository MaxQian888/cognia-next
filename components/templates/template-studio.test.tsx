import { act, fireEvent, render, screen } from "@testing-library/react"

let catalogDefinitions: Array<Record<string, unknown>> = []
// `mock`-prefixed so the hoisted `jest.mock` factories may close over them.
let mockPlatform = "mobile"
const mockSaveDraft = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))
jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions: catalogDefinitions, revision: 0 }),
}))
jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({
    repository: {
      listPackages: async () => [],
      listInstances: async () => [],
    },
    service: {
      saveDraft: (...args: unknown[]) => mockSaveDraft(...args),
    },
  }),
}))

import { TemplateStudio } from "./template-studio"

/** A user-owned draft of a full domain — the only kind that is editable. */
function draftDefinition(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "cognia.dev/templates/v1",
    id: "user.skill.notes",
    domain: "skill",
    version: null,
    status: "draft",
    revision: 4,
    metadata: { name: "Notes", description: "Take notes" },
    payload: { name: "Notes", content: "" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop"] },
    provenance: { source: "user", trust: "unsigned" },
    contentHash: "sha256:notes",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

async function openDraftEditor() {
  await act(async () => {
    render(<TemplateStudio />)
  })
  fireEvent.click(screen.getByRole("button", { name: "draftEditor.title" }))
}

describe("TemplateStudio", () => {
  beforeEach(() => {
    catalogDefinitions = []
    mockPlatform = "mobile"
    mockSaveDraft.mockReset()
    window.history.replaceState({}, "", "/templates")
  })

  it("keeps mobile browsing available while replacing authoring with a desktop handoff", async () => {
    await act(async () => {
      render(<TemplateStudio />)
    })

    expect(screen.getByTestId("template-studio")).toBeInTheDocument()
    expect(screen.getByText("mobile.title")).toBeInTheDocument()
    expect(screen.queryByText("actions.newDraft")).not.toBeInTheDocument()
    expect(screen.getByText("tabs.library")).toBeInTheDocument()
  })

  it("selects a catalog definition from a deep link", async () => {
    catalogDefinitions = [
      {
        apiVersion: "cognia.dev/templates/v1",
        id: "team.review",
        domain: "agentTeam",
        version: "1.0.0",
        status: "published",
        revision: 1,
        metadata: { name: "Review Team", description: "Review changes" },
        payload: {},
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["mobile"] },
        provenance: { source: "user", trust: "unsigned" },
        contentHash: "sha256:review",
        baselineHash: "sha256:review",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ]
    window.history.replaceState({}, "", "/templates?definition=team.review")

    await act(async () => {
      render(<TemplateStudio />)
    })

    expect(screen.getByText("team.review@1.0.0")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "inspector.payload" }))
    expect(screen.getByText("{}")).toBeInTheDocument()
  })

  describe("editing a draft", () => {
    // Regression: `service.saveDraft` had no caller anywhere in the app, and
    // the per-domain "open editor" link points at `?mode=template-authoring`,
    // which nothing in the repository handles. A template was write-once from
    // the moment it was created.
    beforeEach(() => {
      mockPlatform = "desktop"
      catalogDefinitions = [draftDefinition()]
      window.history.replaceState({}, "", "/templates?definition=user.skill.notes")
    })

    it("saves the edited name and payload against the draft's current revision", async () => {
      mockSaveDraft.mockResolvedValue(
        draftDefinition({ revision: 5, contentHash: "sha256:notes-2" })
      )
      await openDraftEditor()

      fireEvent.change(screen.getByLabelText("draftEditor.name"), {
        target: { value: "Meeting notes" },
      })
      fireEvent.change(screen.getByLabelText("draftEditor.payload"), {
        target: { value: '{"name":"Meeting notes","content":"# Agenda"}' },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })

      expect(mockSaveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user.skill.notes",
          metadata: expect.objectContaining({ name: "Meeting notes" }),
          payload: { name: "Meeting notes", content: "# Agenda" },
        }),
        4
      )
      expect(screen.getByText("messages.draftSaved")).toBeInTheDocument()
    })

    it("refuses to save an unparseable payload instead of sending it", async () => {
      await openDraftEditor()

      fireEvent.change(screen.getByLabelText("draftEditor.payload"), {
        target: { value: "{ not json" },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })

      expect(mockSaveDraft).not.toHaveBeenCalled()
      expect(screen.getByText("draftEditor.invalidJson")).toBeInTheDocument()
    })

    it("surfaces the validation reasons saveDraft raises", async () => {
      mockSaveDraft.mockRejectedValue(
        new Error("Template draft is invalid: apiKey must be a secret reference slot")
      )
      await openDraftEditor()

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })

      expect(screen.getByText(/apiKey must be a secret reference slot/)).toBeInTheDocument()
    })

    it("says the edit was forked when the draft had already moved on", async () => {
      // A revision clash does not fail — `saveDraft` writes the edit to its own
      // conflict draft under a new id. Reporting a plain success would leave the
      // user believing they had changed the row they were looking at.
      mockSaveDraft.mockResolvedValue(
        draftDefinition({ id: "user.skill.notes.conflict.abc", contentHash: "sha256:fork" })
      )
      await openDraftEditor()

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })

      expect(screen.getByText("messages.draftForked")).toBeInTheDocument()
      expect(screen.queryByText("messages.draftSaved")).not.toBeInTheDocument()
    })

    it("leaves a published release read-only", async () => {
      // `DexieTemplateRepository` refuses to overwrite a release, so offering an
      // editor for one would only ever produce an error.
      catalogDefinitions = [draftDefinition({ status: "published", version: "1.0.0" })]
      await act(async () => {
        render(<TemplateStudio />)
      })

      expect(screen.queryByRole("button", { name: "draftEditor.title" })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "inspector.payload" }))
      expect(screen.queryByTestId("template-draft-editor")).not.toBeInTheDocument()
    })
  })
})
