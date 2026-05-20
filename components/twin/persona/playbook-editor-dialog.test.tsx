/** @jest-environment jsdom */
/**
 * Covers PlaybookEditorDialog: open/closed render, required-field validation,
 * textToSteps/stepsToText round-trips, PII gate, pinned:true on add vs preserved
 * on edit, and confidence clamping at submit time.
 */

import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("nanoid", () => ({ nanoid: () => "test-id" }))

const mockAssertFieldsClean = jest.fn()
jest.mock("@/lib/twin/distill/draft-pii-guard", () => {
  const { DraftPiiError } = jest.requireActual<typeof import("@/lib/twin/distill/draft-pii-guard")>(
    "@/lib/twin/distill/draft-pii-guard"
  )
  return {
    DraftPiiError,
    assertFieldsClean: (...args: unknown[]) => mockAssertFieldsClean(...args),
  }
})

import { PlaybookEditorDialog } from "./playbook-editor-dialog"
import type { Playbook, PlaybookStep } from "@/types/twin"
import { DraftPiiError } from "@/lib/twin/distill/draft-pii-guard"

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    title: "On-call response",
    trigger: "when an incident fires",
    steps: [
      { order: 1, action: "ack the page" },
      { order: 2, action: "open a war room", rationale: "keeps discussion focused" },
    ],
    examples: [],
    confidence: 0.7,
    pinned: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockAssertFieldsClean.mockReset()
  mockAssertFieldsClean.mockReturnValue(undefined)
})

describe("PlaybookEditorDialog — closed", () => {
  it("renders nothing when open=false", () => {
    render(
      <PlaybookEditorDialog
        open={false}
        onOpenChange={jest.fn()}
        playbook={null}
        onSave={jest.fn()}
      />
    )
    expect(screen.queryByTestId("playbook-editor-dialog")).toBeNull()
  })
})

describe("PlaybookEditorDialog — add mode", () => {
  it("renders dialog with Add title when open=true and playbook=null", () => {
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={null}
        onSave={jest.fn()}
      />
    )
    expect(screen.getByTestId("playbook-editor-dialog")).toBeInTheDocument()
    // en.json: playbook.titleAdd = "Add playbook"
    expect(screen.getByText("Add playbook")).toBeInTheDocument()
  })

  it("blocks save and shows error when title is empty", async () => {
    const onSave = jest.fn()
    render(
      <PlaybookEditorDialog open={true} onOpenChange={jest.fn()} playbook={null} onSave={onSave} />
    )
    // Leave title blank, fill trigger and steps
    await userEvent.type(screen.getByTestId("playbook-editor-trigger"), "some trigger")
    await userEvent.type(screen.getByTestId("playbook-editor-steps"), "step one")
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(screen.getByTestId("playbook-editor-error")).toBeInTheDocument())
    // en.json: playbook.titleRequired = "Title is required."
    expect(screen.getByTestId("playbook-editor-error")).toHaveTextContent("Title is required.")
    expect(onSave).not.toHaveBeenCalled()
  })

  it("blocks save and shows error when trigger is empty", async () => {
    const onSave = jest.fn()
    render(
      <PlaybookEditorDialog open={true} onOpenChange={jest.fn()} playbook={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("playbook-editor-title"), "My playbook")
    // Leave trigger blank
    await userEvent.type(screen.getByTestId("playbook-editor-steps"), "step one")
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(screen.getByTestId("playbook-editor-error")).toBeInTheDocument())
    // en.json: playbook.triggerRequired = "Trigger is required."
    expect(screen.getByTestId("playbook-editor-error")).toHaveTextContent("Trigger is required.")
    expect(onSave).not.toHaveBeenCalled()
  })

  it("blocks save and shows error when steps textarea is empty", async () => {
    const onSave = jest.fn()
    render(
      <PlaybookEditorDialog open={true} onOpenChange={jest.fn()} playbook={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("playbook-editor-title"), "My playbook")
    await userEvent.type(screen.getByTestId("playbook-editor-trigger"), "some trigger")
    // Leave steps blank
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(screen.getByTestId("playbook-editor-error")).toBeInTheDocument())
    // en.json: playbook.stepsRequired = "At least one step is required."
    expect(screen.getByTestId("playbook-editor-error")).toHaveTextContent(
      "At least one step is required."
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it("calls onSave with parsed steps, pinned:true, and generated id on a clean add", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <PlaybookEditorDialog open={true} onOpenChange={jest.fn()} playbook={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("playbook-editor-title"), "Deploy checklist")
    await userEvent.type(screen.getByTestId("playbook-editor-trigger"), "before every deploy")
    await userEvent.type(
      screen.getByTestId("playbook-editor-steps"),
      "run tests — CI must be green\nmerge PR"
    )
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as Playbook
    expect(saved.id).toBe("test-id")
    expect(saved.title).toBe("Deploy checklist")
    expect(saved.trigger).toBe("before every deploy")
    expect(saved.pinned).toBe(true)
    // textToSteps parses "action — rationale" format
    expect(saved.steps).toHaveLength(2)
    expect(saved.steps[0]).toMatchObject<PlaybookStep>({
      order: 1,
      action: "run tests",
      rationale: "CI must be green",
    })
    expect(saved.steps[1]).toMatchObject<PlaybookStep>({ order: 2, action: "merge PR" })
  })

  it("surfaces PII error and blocks save when assertFieldsClean throws", async () => {
    mockAssertFieldsClean.mockImplementation(() => {
      throw new DraftPiiError([{ field: "title" as "name", message: "PII found" }])
    })
    const onSave = jest.fn()
    render(
      <PlaybookEditorDialog open={true} onOpenChange={jest.fn()} playbook={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("playbook-editor-title"), "Call eve@example.com")
    await userEvent.type(screen.getByTestId("playbook-editor-trigger"), "some trigger")
    await userEvent.type(screen.getByTestId("playbook-editor-steps"), "step one")
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(screen.getByTestId("playbook-editor-error")).toBeInTheDocument())
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId("playbook-editor-error")).toHaveTextContent("title")
  })
})

describe("PlaybookEditorDialog — stepsToText / textToSteps round-trip", () => {
  it("pre-populates the steps textarea with sorted action — rationale lines", () => {
    const playbook = makePlaybook({
      steps: [
        { order: 2, action: "open a war room", rationale: "keeps discussion focused" },
        { order: 1, action: "ack the page" },
      ],
    })
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={jest.fn()}
      />
    )
    const textarea = screen.getByTestId("playbook-editor-steps") as HTMLTextAreaElement
    const lines = textarea.value.split("\n")
    // Should be sorted by order: first ack the page (order 1), then war room (order 2)
    expect(lines[0]).toBe("ack the page")
    expect(lines[1]).toBe("open a war room — keeps discussion focused")
  })

  it("round-trips steps without rationale correctly", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <PlaybookEditorDialog open={true} onOpenChange={jest.fn()} playbook={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("playbook-editor-title"), "Checklist")
    await userEvent.type(screen.getByTestId("playbook-editor-trigger"), "always")
    await userEvent.type(screen.getByTestId("playbook-editor-steps"), "first step\nsecond step")
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const steps = (onSave.mock.calls[0][0] as Playbook).steps
    expect(steps[0]).toEqual({ order: 1, action: "first step", rationale: undefined })
    expect(steps[1]).toEqual({ order: 2, action: "second step", rationale: undefined })
  })
})

describe("PlaybookEditorDialog — edit mode", () => {
  it("renders Edit title and pre-populates fields", () => {
    const playbook = makePlaybook({ title: "Incident response", trigger: "on alert" })
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={jest.fn()}
      />
    )
    // en.json: playbook.titleEdit = "Edit playbook"
    expect(screen.getByText("Edit playbook")).toBeInTheDocument()
    expect(screen.getByTestId("playbook-editor-title")).toHaveValue("Incident response")
    expect(screen.getByTestId("playbook-editor-trigger")).toHaveValue("on alert")
  })

  it("preserves pinned:false from existing playbook on edit", async () => {
    const playbook = makePlaybook({ pinned: false })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Playbook).pinned).toBe(false)
  })

  it("preserves pinned:true from existing playbook on edit", async () => {
    const playbook = makePlaybook({ pinned: true })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Playbook).pinned).toBe(true)
  })

  it("preserves the original id on edit", async () => {
    const playbook = makePlaybook({ id: "existing-pb-id" })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Playbook).id).toBe("existing-pb-id")
  })

  it("clamps confidence to [0, 1] when an out-of-range value is typed", async () => {
    const playbook = makePlaybook()
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={onSave}
      />
    )
    const confidenceInput = screen.getByTestId("playbook-editor-confidence")
    await userEvent.clear(confidenceInput)
    await userEvent.type(confidenceInput, "5")
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Playbook).confidence).toBe(1)
  })

  it("surfaces onSave rejection as an inline error", async () => {
    const playbook = makePlaybook()
    const onSave = jest.fn().mockRejectedValue(new Error("db write failed"))
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={playbook}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("playbook-editor-save"))

    await waitFor(() =>
      expect(screen.getByTestId("playbook-editor-error")).toHaveTextContent("db write failed")
    )
  })
})

describe("PlaybookEditorDialog — busy state", () => {
  it("disables inputs and buttons when busy=true", () => {
    render(
      <PlaybookEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        playbook={null}
        onSave={jest.fn()}
        busy={true}
      />
    )
    expect(screen.getByTestId("playbook-editor-title")).toBeDisabled()
    expect(screen.getByTestId("playbook-editor-save")).toBeDisabled()
  })
})
