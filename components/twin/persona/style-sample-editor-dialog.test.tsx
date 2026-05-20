/** @jest-environment jsdom */
/**
 * Covers StyleSampleEditorDialog: open/closed render, required-field validation,
 * tone tag parsing (add/remove via comma-separated input), confidence-like
 * clamping is N/A here but PII gate, pinned:true on add vs preserved on edit
 * are fully exercised.
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

jest.mock("nanoid", () => ({ nanoid: () => "test-style-id" }))

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

import { StyleSampleEditorDialog } from "./style-sample-editor-dialog"
import type { StyleSample } from "@/types/twin"
import { DraftPiiError } from "@/lib/twin/distill/draft-pii-guard"

const BASE_TIMESTAMP = 1_700_000_000_000

function makeSample(overrides: Partial<StyleSample> = {}): StyleSample {
  return {
    id: "ss-1",
    contextLabel: "PR description",
    original: "We chose Kafka because durability matters",
    summary: "Kafka chosen for durability",
    sourceChunkId: "chunk-1",
    tone: ["concise", "decisive"],
    addedAt: BASE_TIMESTAMP,
    addedBy: "distill",
    pinned: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockAssertFieldsClean.mockReset()
  mockAssertFieldsClean.mockReturnValue(undefined)
})

describe("StyleSampleEditorDialog — closed", () => {
  it("renders nothing when open=false", () => {
    render(
      <StyleSampleEditorDialog
        open={false}
        onOpenChange={jest.fn()}
        sample={null}
        onSave={jest.fn()}
      />
    )
    expect(screen.queryByTestId("style-sample-editor-dialog")).toBeNull()
  })
})

describe("StyleSampleEditorDialog — add mode", () => {
  it("renders dialog with Add title when open=true and sample=null", () => {
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={null}
        onSave={jest.fn()}
      />
    )
    expect(screen.getByTestId("style-sample-editor-dialog")).toBeInTheDocument()
    // en.json: styleSample.titleAdd = "Add style sample"
    expect(screen.getByText("Add style sample")).toBeInTheDocument()
  })

  it("blocks save and shows error when original text is empty", async () => {
    const onSave = jest.fn()
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    // Leave original blank; fill summary
    await userEvent.type(screen.getByTestId("style-editor-summary"), "some summary")
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(screen.getByTestId("style-editor-error")).toBeInTheDocument())
    // en.json: styleSample.originalRequired = "Original text is required."
    expect(screen.getByTestId("style-editor-error")).toHaveTextContent("Original text is required.")
    expect(onSave).not.toHaveBeenCalled()
  })

  it("blocks save and shows error when summary is empty", async () => {
    const onSave = jest.fn()
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    await userEvent.type(
      screen.getByTestId("style-editor-original"),
      "We chose Kafka because durability"
    )
    // Leave summary blank
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(screen.getByTestId("style-editor-error")).toBeInTheDocument())
    // en.json: styleSample.summaryRequired = "Summary is required."
    expect(screen.getByTestId("style-editor-error")).toHaveTextContent("Summary is required.")
    expect(onSave).not.toHaveBeenCalled()
  })

  it("calls onSave with correct shape, parsed tone tags, and pinned:true on a clean add", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("style-editor-context"), "Slack message")
    await userEvent.type(screen.getByTestId("style-editor-original"), "Shipped the auth fix 🎉")
    await userEvent.type(screen.getByTestId("style-editor-summary"), "brief ship announcement")
    // Tone tags: comma-separated, spaces should be trimmed
    await userEvent.type(screen.getByTestId("style-editor-tone"), "casual,  friendly , brief")
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as StyleSample
    expect(saved.id).toBe("test-style-id")
    expect(saved.contextLabel).toBe("Slack message")
    expect(saved.original).toBe("Shipped the auth fix 🎉")
    expect(saved.summary).toBe("brief ship announcement")
    expect(saved.tone).toEqual(["casual", "friendly", "brief"])
    expect(saved.addedBy).toBe("manual")
    expect(saved.sourceChunkId).toBe("manual")
    expect(saved.pinned).toBe(true)
  })

  it("uses the default context label when context field is left blank", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    // Leave context blank
    await userEvent.type(screen.getByTestId("style-editor-original"), "some original text")
    await userEvent.type(screen.getByTestId("style-editor-summary"), "some summary")
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as StyleSample
    // en.json: styleSample.defaultLabel = "Manual sample"
    expect(saved.contextLabel).toBe("Manual sample")
  })

  it("surfaces PII error and blocks save when assertFieldsClean throws", async () => {
    mockAssertFieldsClean.mockImplementation(() => {
      throw new DraftPiiError([{ field: "original" as "name", message: "PII found" }])
    })
    const onSave = jest.fn()
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("style-editor-original"), "ping alice@example.com")
    await userEvent.type(screen.getByTestId("style-editor-summary"), "pii summary")
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(screen.getByTestId("style-editor-error")).toBeInTheDocument())
    expect(onSave).not.toHaveBeenCalled()
    // en.json piiError uses {fields} interpolation; "original" should appear
    expect(screen.getByTestId("style-editor-error")).toHaveTextContent("original")
  })
})

describe("StyleSampleEditorDialog — tone tag chip semantics", () => {
  it("adds new tags by appending to the comma-separated input", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("style-editor-original"), "original body")
    await userEvent.type(screen.getByTestId("style-editor-summary"), "summary body")
    // Type two tone tags separated by comma
    const toneInput = screen.getByTestId("style-editor-tone")
    await userEvent.type(toneInput, "formal, technical")
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as StyleSample).tone).toEqual(["formal", "technical"])
  })

  it("removes a tag by clearing the input of its value before save", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("style-editor-original"), "original body")
    await userEvent.type(screen.getByTestId("style-editor-summary"), "summary body")
    const toneInput = screen.getByTestId("style-editor-tone")
    await userEvent.type(toneInput, "formal, technical, brief")
    // Simulate user removing "technical" by clearing and retyping remaining tags
    await userEvent.clear(toneInput)
    await userEvent.type(toneInput, "formal, brief")
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as StyleSample).tone).toEqual(["formal", "brief"])
  })

  it("produces an empty tone array when tone input is blank", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog open={true} onOpenChange={jest.fn()} sample={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("style-editor-original"), "original body")
    await userEvent.type(screen.getByTestId("style-editor-summary"), "summary body")
    // Leave tone blank
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as StyleSample).tone).toEqual([])
  })
})

describe("StyleSampleEditorDialog — edit mode", () => {
  it("renders Edit title and pre-populates all fields", () => {
    const sample = makeSample()
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={sample}
        onSave={jest.fn()}
      />
    )
    // en.json: styleSample.titleEdit = "Edit style sample"
    expect(screen.getByText("Edit style sample")).toBeInTheDocument()
    expect(screen.getByTestId("style-editor-context")).toHaveValue("PR description")
    expect(screen.getByTestId("style-editor-original")).toHaveValue(
      "We chose Kafka because durability matters"
    )
    expect(screen.getByTestId("style-editor-summary")).toHaveValue("Kafka chosen for durability")
    // tone joined with ", "
    expect(screen.getByTestId("style-editor-tone")).toHaveValue("concise, decisive")
  })

  it("preserves pinned:false from existing sample on edit", async () => {
    const sample = makeSample({ pinned: false })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={sample}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as StyleSample).pinned).toBe(false)
  })

  it("preserves pinned:true from existing sample on edit", async () => {
    const sample = makeSample({ pinned: true })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={sample}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as StyleSample).pinned).toBe(true)
  })

  it("preserves original id and addedAt on edit", async () => {
    const sample = makeSample({ id: "ss-original", addedAt: BASE_TIMESTAMP })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={sample}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as StyleSample
    expect(saved.id).toBe("ss-original")
    expect(saved.addedAt).toBe(BASE_TIMESTAMP)
  })

  it("surfaces onSave rejection as an inline error", async () => {
    const sample = makeSample()
    const onSave = jest.fn().mockRejectedValue(new Error("db error"))
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={sample}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByTestId("style-editor-save"))

    await waitFor(() =>
      expect(screen.getByTestId("style-editor-error")).toHaveTextContent("db error")
    )
  })
})

describe("StyleSampleEditorDialog — busy state", () => {
  it("disables all inputs and buttons when busy=true", () => {
    render(
      <StyleSampleEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        sample={null}
        onSave={jest.fn()}
        busy={true}
      />
    )
    expect(screen.getByTestId("style-editor-original")).toBeDisabled()
    expect(screen.getByTestId("style-editor-summary")).toBeDisabled()
    expect(screen.getByTestId("style-editor-save")).toBeDisabled()
  })
})
