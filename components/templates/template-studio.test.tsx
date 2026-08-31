import { act, fireEvent, render, screen } from "@testing-library/react"

let catalogDefinitions: Array<Record<string, unknown>> = []
// `mock`-prefixed so the hoisted `jest.mock` factories may close over them.
let mockPlatform = "mobile"
const mockSaveDraft = jest.fn()
const mockDeleteDraft = jest.fn()
const mockDeprecate = jest.fn()
let mockPackages: Array<Record<string, unknown>> = []

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
// The Studio reads `?definition=` through `useSearchParams` so a second
// hand-off into an already-open Studio re-selects. These tests drive the URL
// with `history.replaceState`, so the mock reads the same place.
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))
jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions: catalogDefinitions, revision: 0 }),
}))
jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({
    repository: {
      listPackages: async () => mockPackages,
      listInstances: async () => [],
    },
    service: {
      saveDraft: (...args: unknown[]) => mockSaveDraft(...args),
      deleteDraft: (...args: unknown[]) => mockDeleteDraft(...args),
      deprecate: (...args: unknown[]) => mockDeprecate(...args),
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
    mockDeleteDraft.mockReset()
    mockDeprecate.mockReset()
    mockPackages = []
    window.history.replaceState({}, "", "/templates")
  })

  it("keeps mobile browsing available while replacing authoring with a desktop handoff", async () => {
    await act(async () => {
      render(<TemplateStudio />)
    })

    expect(screen.getByTestId("template-studio")).toBeInTheDocument()
    // The Studio is on the shared feature shell, which is what owns
    // `data-bg-target` and the panel-size persistence it used to lack.
    expect(screen.getByTestId("feature-shell-templates")).toBeInTheDocument()
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

  // `repository.deleteDraft` was reachable only from the migration rollback
  // path, and `setReleaseStatus` only ever got its "deprecated" half, so a
  // mistaken draft and a release that should never be installed again were both
  // permanent.
  it("deletes a draft through the service", async () => {
    mockPlatform = "desktop"
    catalogDefinitions = [draftDefinition()]
    mockDeleteDraft.mockResolvedValue(undefined)
    window.history.replaceState({}, "", "/templates?definition=user.skill.notes")
    await act(async () => {
      render(<TemplateStudio />)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId("template-delete-draft"))
    })

    expect(mockDeleteDraft).toHaveBeenCalledWith("user.skill.notes")
    expect(screen.getByText("messages.draftDeleted")).toBeInTheDocument()
  })

  it("yanks a release, not only deprecates it", async () => {
    mockPlatform = "desktop"
    catalogDefinitions = [
      draftDefinition({ status: "published", version: "1.2.0", contentHash: "sha256:pub" }),
    ]
    mockDeprecate.mockResolvedValue(undefined)
    window.history.replaceState({}, "", "/templates?definition=user.skill.notes")
    await act(async () => {
      render(<TemplateStudio />)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId("template-yank"))
    })

    expect(mockDeprecate).toHaveBeenCalledWith("user.skill.notes", "1.2.0", "yanked")
  })

  it("opens the export picker rather than exporting one release blind", async () => {
    mockPlatform = "desktop"
    catalogDefinitions = [
      draftDefinition({ status: "published", version: "1.2.0", contentHash: "sha256:pub" }),
    ]
    window.history.replaceState({}, "", "/templates?definition=user.skill.notes")
    await act(async () => {
      render(<TemplateStudio />)
    })

    expect(screen.queryByTestId("template-export-dialog")).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /actions.export/ }))
    })
    expect(screen.getByTestId("template-export-dialog")).toBeInTheDocument()
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

    // Regression: `createDraft` passes `inputs: []` and the editor had no way to
    // add one, so a Studio-authored template could not parameterise anything —
    // the interpolation the payload validator has always insisted on had no
    // authoring surface to produce it.
    it("declares the payload's undeclared tokens and saves them", async () => {
      mockSaveDraft.mockResolvedValue(
        draftDefinition({ revision: 5, contentHash: "sha256:notes-2" })
      )
      await openDraftEditor()

      fireEvent.change(screen.getByLabelText("draftEditor.payload"), {
        target: { value: '{"name":"{{topic}} notes","content":"about {{topic}}"}' },
      })
      // Reported once, not once per occurrence, and offered while it is still
      // fixable rather than after the save bounces.
      expect(screen.getByText("inputs.undeclared")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "inputs.declareAll" }))
      // Declared now, so the offer is gone.
      expect(screen.queryByText("inputs.undeclared")).not.toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })

      expect(mockSaveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: [{ id: "topic", label: "topic", required: true, kind: "string" }],
        }),
        4
      )
    })

    // Regression: `createDraft` hard-coded all three platforms, an empty
    // dependency list and an empty capability list, and the editor rendered
    // none of them. Three preflight gates were therefore unreachable from the
    // only surface that can author a template.
    it("saves the compatibility and dependency fields the draft editor now owns", async () => {
      mockSaveDraft.mockResolvedValue(draftDefinition({ revision: 5 }))
      await openDraftEditor()

      fireEvent.click(screen.getByLabelText("platforms.web"))
      fireEvent.change(screen.getByLabelText("minHostVersion"), {
        target: { value: "2.0.0" },
      })
      fireEvent.change(screen.getByLabelText("author"), {
        target: { value: "Ada" },
      })
      fireEvent.click(screen.getByRole("button", { name: /addDependency/ }))
      fireEvent.change(screen.getByLabelText("dependencyId"), {
        target: { value: "user.skill.base" },
      })

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })

      expect(mockSaveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ name: "Notes", author: "Ada" }),
          compatibility: { platforms: ["desktop", "web"], minHostVersion: "2.0.0" },
          dependencies: [{ id: "user.skill.base", kind: "template", requirement: "required" }],
        }),
        4
      )
    })

    it("adds, edits and removes an input by hand", async () => {
      mockSaveDraft.mockResolvedValue(draftDefinition({ revision: 5 }))
      await openDraftEditor()

      expect(screen.getByText("inputs.none")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "inputs.add" }))
      fireEvent.change(screen.getByLabelText("inputs.id"), { target: { value: "depth" } })
      fireEvent.change(screen.getByLabelText("inputs.label"), { target: { value: "Depth" } })
      fireEvent.change(screen.getByLabelText("inputs.default"), { target: { value: "quick" } })

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "draftEditor.save" }))
      })
      expect(mockSaveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: [
            { id: "depth", label: "Depth", required: true, kind: "string", defaultValue: "quick" },
          ],
        }),
        4
      )

      fireEvent.click(screen.getByRole("button", { name: "inputs.remove" }))
      expect(screen.getByText("inputs.none")).toBeInTheDocument()
    })

    it("keeps the inputs an existing draft already declares", async () => {
      catalogDefinitions = [
        draftDefinition({
          inputs: [{ id: "topic", label: "Topic", required: false, kind: "string" }],
        }),
      ]
      await openDraftEditor()

      expect(screen.getByLabelText("inputs.id")).toHaveValue("topic")
      expect(screen.getByLabelText("inputs.label")).toHaveValue("Topic")
    })

    // A workflow expression belongs to the workflow engine. Offering to declare
    // one would turn a live expression into a dead string on the next save.
    it("does not offer to declare a workflow expression in a workflow payload", async () => {
      catalogDefinitions = [draftDefinition({ domain: "workflow" })]
      await openDraftEditor()

      fireEvent.change(screen.getByLabelText("draftEditor.payload"), {
        target: { value: '{"value":"{{ $node[\'a\'].output }}"}' },
      })
      expect(screen.queryByText("inputs.undeclared")).not.toBeInTheDocument()
    })

    // Declaring `$node['a'].output` would produce an `input.id` error on save —
    // an offer that cannot succeed is worse than no offer.
    it("says why a token cannot become an input rather than offering to declare it", async () => {
      await openDraftEditor()

      fireEvent.change(screen.getByLabelText("draftEditor.payload"), {
        target: { value: '{"value":"{{ $node[\'a\'].output }}"}' },
      })
      expect(screen.queryByRole("button", { name: "inputs.declareAll" })).not.toBeInTheDocument()
      expect(screen.getByText("inputs.undeclarableHint")).toBeInTheDocument()
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

  it("offers every domain in the filter, not only the six with adapters", async () => {
    // The six catalog-only domains render a domain badge and carry i18n
    // labels, but were absent from the filter, so half the catalog could be
    // seen on a card and never filtered to.
    mockPlatform = "tauri"
    await act(async () => {
      render(<TemplateStudio />)
    })
    const trigger = screen.getByLabelText("filters.domain")
    fireEvent.click(trigger)
    for (const domain of ["a2ui", "goal", "scheduler", "prompt", "subscription", "document"]) {
      expect(screen.getByText(`domains.${domain}`)).toBeInTheDocument()
    }
  })
})
