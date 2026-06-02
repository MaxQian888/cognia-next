/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { CaseEditor } from "./case-editor"

describe("CaseEditor", () => {
  it("saves the input + parsed reference fields", () => {
    const onSave = jest.fn()
    render(<CaseEditor onSave={onSave} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("case.input"), { target: { value: "hello" } })
    fireEvent.change(screen.getByLabelText("case.expectedOutput"), { target: { value: "world" } })
    fireEvent.change(screen.getByLabelText("case.expectedTools"), {
      target: { value: "Read, Edit" },
    })
    fireEvent.click(screen.getByText("case.save"))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "hello",
        reference: expect.objectContaining({
          expectedOutput: "world",
          expectedTools: ["Read", "Edit"],
        }),
      })
    )
  })

  it("parses multi-line contains/context and valid expectedToolArgs JSON", () => {
    const onSave = jest.fn()
    render(<CaseEditor onSave={onSave} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("case.input"), { target: { value: "x" } })
    fireEvent.change(screen.getByLabelText("case.expectedContains"), {
      target: { value: "alpha\n\nbeta" },
    })
    fireEvent.change(screen.getByLabelText("case.expectedContext"), {
      target: { value: "ctx1\nctx2" },
    })
    fireEvent.change(screen.getByLabelText("case.split"), { target: { value: "test" } })
    fireEvent.change(screen.getByLabelText("case.notes"), { target: { value: "a note" } })
    fireEvent.change(screen.getByLabelText("case.expectedToolArgs"), {
      target: { value: '{"Read":{"path":"x"}}' },
    })
    fireEvent.click(screen.getByText("case.save"))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        split: "test",
        notes: "a note",
        reference: expect.objectContaining({
          expectedContains: ["alpha", "beta"],
          expectedContext: ["ctx1", "ctx2"],
          expectedToolArgs: { Read: { path: "x" } },
        }),
      })
    )
  })

  it("blocks save and shows an error on invalid expectedToolArgs JSON", () => {
    const onSave = jest.fn()
    render(<CaseEditor onSave={onSave} onCancel={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("case.input"), { target: { value: "x" } })
    fireEvent.change(screen.getByLabelText("case.expectedToolArgs"), {
      target: { value: "{ not json" },
    })
    fireEvent.click(screen.getByText("case.save"))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("disables save with empty input and prefills from initial", () => {
    const onSave = jest.fn()
    render(
      <CaseEditor
        initial={{ input: "seed", tags: ["t1"], reference: { expectedOutput: "o" } }}
        onSave={onSave}
        onCancel={jest.fn()}
      />
    )
    expect((screen.getByLabelText("case.input") as HTMLTextAreaElement).value).toBe("seed")
    expect((screen.getByLabelText("case.tags") as HTMLInputElement).value).toBe("t1")
    fireEvent.click(screen.getByText("case.save"))
    expect(onSave).toHaveBeenCalled()
  })

  it("cancels", () => {
    const onCancel = jest.fn()
    render(<CaseEditor onSave={jest.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText("case.cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})
