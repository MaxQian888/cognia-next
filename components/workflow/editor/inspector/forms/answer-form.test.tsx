/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({
    id,
    value,
    onChange,
  }: {
    id: string
    value: string
    onChange: (value: string) => void
  }) => <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} />,
}))

import { AnswerConfig } from "./answer-form"

describe("<AnswerConfig />", () => {
  it("edits text, structured content, citations, files, and suggestions", () => {
    const onChange = jest.fn()
    render(<AnswerConfig params={{}} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText("text.label"), { target: { value: "Hello" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Hello" }))

    fireEvent.change(screen.getByLabelText("content.label"), {
      target: { value: '{"kind":"card"}' },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: { kind: "card" } })
    )

    fireEvent.change(screen.getByLabelText("citations.label"), {
      target: {
        value: '[{"sourceId":"s","documentId":"d","revisionId":"r","chunkId":"c"}]',
      },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ citations: [expect.objectContaining({ chunkId: "c" })] })
    )

    fireEvent.change(screen.getByLabelText("files.label"), {
      target: { value: '[{"ref":"file:1"}]' },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ files: [{ ref: "file:1" }] })
    )

    fireEvent.change(screen.getByLabelText("suggestions.label"), {
      target: { value: "Next\nExplain" },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ suggestions: ["Next", "Explain"] })
    )
  })

  it("keeps invalid JSON authoring text while removing stale parsed values", () => {
    const onChange = jest.fn()
    render(
      <AnswerConfig
        params={{ content: { stale: true }, contentJson: '{"stale":true}' }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText("content.label"), { target: { value: "{" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ contentJson: "{" }))
    expect(onChange.mock.calls.at(-1)?.[0]).not.toHaveProperty("content")
  })
})
