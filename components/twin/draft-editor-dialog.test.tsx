/**
 * Coverage for the M4 edit-before-accept dialog.
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DraftEditorDialog } from "./draft-editor-dialog"
import type { TwinDraft } from "@/types/twin"

function characterDraft(overrides: Partial<Record<string, unknown>> = {}): TwinDraft {
  return {
    id: "drf_c1",
    twinId: "twin_a",
    jobId: "job_1",
    kind: "character",
    payload: {
      kind: "character",
      data: {
        name: "Test Twin",
        description: "Test character desc",
        systemPrompt: "You are a careful reviewer.",
        voiceSummary: "Concise, professional",
        ...overrides,
      },
    },
    provenance: { chunkIds: [], rationale: "" },
    status: "pending",
    createdAt: Date.now(),
  }
}

function skillDraft(): TwinDraft {
  return {
    id: "drf_s1",
    twinId: "twin_a",
    jobId: "job_1",
    kind: "skill",
    payload: {
      kind: "skill",
      data: {
        name: "Triage P1",
        description: "Outage triage runbook",
        content: "## Steps\n1. Ack",
      },
    },
    provenance: { chunkIds: [], rationale: "" },
    status: "pending",
    createdAt: Date.now(),
  }
}

describe("DraftEditorDialog", () => {
  it("renders character fields including voiceSummary", () => {
    render(
      <DraftEditorDialog
        open
        onOpenChange={jest.fn()}
        draft={characterDraft()}
        onSave={jest.fn()}
      />
    )
    expect(screen.getByTestId("twin-draft-editor-name")).toHaveValue("Test Twin")
    expect(screen.getByTestId("twin-draft-editor-body")).toHaveValue("You are a careful reviewer.")
    expect(screen.getByTestId("twin-draft-editor-voice")).toHaveValue("Concise, professional")
  })

  it("renders skill fields and hides the voiceSummary input", () => {
    render(
      <DraftEditorDialog open onOpenChange={jest.fn()} draft={skillDraft()} onSave={jest.fn()} />
    )
    expect(screen.getByTestId("twin-draft-editor-name")).toHaveValue("Triage P1")
    expect(screen.queryByTestId("twin-draft-editor-voice")).toBeNull()
  })

  it("keeps Save disabled until the user edits a field", async () => {
    render(
      <DraftEditorDialog
        open
        onOpenChange={jest.fn()}
        draft={characterDraft()}
        onSave={jest.fn()}
      />
    )
    expect(screen.getByTestId("twin-draft-editor-save")).toBeDisabled()
    await userEvent.clear(screen.getByTestId("twin-draft-editor-name"))
    await userEvent.type(screen.getByTestId("twin-draft-editor-name"), "Renamed")
    expect(screen.getByTestId("twin-draft-editor-save")).toBeEnabled()
  })

  it("blocks save when name is empty", async () => {
    const onSave = jest.fn()
    render(
      <DraftEditorDialog open onOpenChange={jest.fn()} draft={characterDraft()} onSave={onSave} />
    )
    await userEvent.clear(screen.getByTestId("twin-draft-editor-name"))
    await userEvent.type(screen.getByTestId("twin-draft-editor-name"), " ")
    await userEvent.click(screen.getByTestId("twin-draft-editor-save"))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/Name is required/i)).toBeInTheDocument()
  })

  it("calls onSave with the modified character payload", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <DraftEditorDialog open onOpenChange={jest.fn()} draft={characterDraft()} onSave={onSave} />
    )
    await userEvent.clear(screen.getByTestId("twin-draft-editor-body"))
    await userEvent.type(screen.getByTestId("twin-draft-editor-body"), "New systemPrompt body")
    await userEvent.click(screen.getByTestId("twin-draft-editor-save"))
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1)
    })
    const payload = onSave.mock.calls[0][0]
    expect(payload.kind).toBe("character")
    expect(payload.data.systemPrompt).toBe("New systemPrompt body")
    // Voice summary preserved from initial state since we didn't touch it.
    expect(payload.data.voiceSummary).toBe("Concise, professional")
  })

  it("calls onSave with the modified skill payload (no systemPrompt/voice)", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(<DraftEditorDialog open onOpenChange={jest.fn()} draft={skillDraft()} onSave={onSave} />)
    await userEvent.clear(screen.getByTestId("twin-draft-editor-body"))
    await userEvent.type(screen.getByTestId("twin-draft-editor-body"), "## Steps\n1. New ack")
    await userEvent.click(screen.getByTestId("twin-draft-editor-save"))
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1)
    })
    const payload = onSave.mock.calls[0][0]
    expect(payload.kind).toBe("skill")
    expect(payload.data.content).toContain("New ack")
    expect(payload.data.systemPrompt).toBeUndefined()
    expect(payload.data.voiceSummary).toBeUndefined()
  })

  it("Cancel button closes via onOpenChange(false)", async () => {
    const onOpenChange = jest.fn()
    render(
      <DraftEditorDialog
        open
        onOpenChange={onOpenChange}
        draft={characterDraft()}
        onSave={jest.fn()}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
