import { fireEvent, render, screen } from "@testing-library/react"
import { StagedSourceReview } from "./staged-source-review"
import type { StagedSource } from "@/lib/twin/ingest/stage"

function staged(title: string, text = "body"): StagedSource {
  return {
    kind: "document",
    format: "markdown",
    title,
    text,
    bytes: text.length,
    origin: "file",
  }
}

const renderError = (err: { code: string }) => `err:${err.code}`

describe("StagedSourceReview", () => {
  it("lists staged items and confirms the selected subset", () => {
    const onConfirm = jest.fn()
    render(
      <StagedSourceReview
        staged={[staged("One"), staged("Two")]}
        committing={false}
        onConfirm={onConfirm}
        onBack={() => {}}
        renderError={renderError}
      />
    )

    expect(screen.getByText(/2 of 2 selected/i)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("twin-add-source-include-1"))
    expect(screen.getByText(/1 of 2 selected/i)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("twin-add-source-confirm"))
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ title: "One" })])
  })

  it("disables confirm when nothing is selected", () => {
    render(
      <StagedSourceReview
        staged={[staged("One")]}
        committing={false}
        onConfirm={() => {}}
        onBack={() => {}}
        renderError={renderError}
      />
    )
    fireEvent.click(screen.getByTestId("twin-add-source-include-0"))
    expect(screen.getByTestId("twin-add-source-confirm")).toBeDisabled()
  })

  it("expands an item into an inline content preview", () => {
    render(
      <StagedSourceReview
        staged={[staged("One", "| A | B |\n| --- | --- |\n| 1 | 2 |")]}
        committing={false}
        onConfirm={() => {}}
        onBack={() => {}}
        renderError={renderError}
      />
    )
    expect(screen.queryByTestId("twin-source-preview-body")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("twin-add-source-expand-0"))
    expect(screen.getByTestId("twin-source-preview-body")).toBeInTheDocument()
  })

  it("shows skipped-file notices and calls back", () => {
    const onBack = jest.fn()
    render(
      <StagedSourceReview
        staged={[staged("One")]}
        notices={[
          { filename: "ok.md", staged: 1 },
          { filename: "bad.xyz", staged: 0, error: { code: "unknownFileType" } },
        ]}
        committing={false}
        onConfirm={() => {}}
        onBack={onBack}
        renderError={renderError}
      />
    )
    const notices = screen.getByTestId("twin-add-source-review-notices")
    expect(notices).toHaveTextContent("bad.xyz")
    expect(notices).toHaveTextContent("err:unknownFileType")
    expect(notices).not.toHaveTextContent("ok.md")

    fireEvent.click(screen.getByRole("button", { name: /back/i }))
    expect(onBack).toHaveBeenCalled()
  })
})
