/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { AutoComposeClarifyStep } from "./auto-compose-clarify-step"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("AutoComposeClarifyStep", () => {
  it("renders one labelled answer input per question", () => {
    render(
      <AutoComposeClarifyStep
        questions={["What is the scope?", "Who are the users?"]}
        answers={["", ""]}
        onAnswerChange={jest.fn()}
      />
    )
    expect(screen.getByText("What is the scope?")).toBeInTheDocument()
    expect(screen.getByText("Who are the users?")).toBeInTheDocument()
    expect(screen.getAllByTestId(/auto-compose-clarify-answer-/)).toHaveLength(2)
  })

  it("reflects the controlled answer values", () => {
    render(
      <AutoComposeClarifyStep
        questions={["Q1", "Q2"]}
        answers={["first answer", ""]}
        onAnswerChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("auto-compose-clarify-answer-0")).toHaveValue("first answer")
    expect(screen.getByTestId("auto-compose-clarify-answer-1")).toHaveValue("")
  })

  it("renders empty inputs when the answers array is shorter than the questions", () => {
    render(
      <AutoComposeClarifyStep questions={["Q1", "Q2"]} answers={[]} onAnswerChange={jest.fn()} />
    )
    expect(screen.getByTestId("auto-compose-clarify-answer-0")).toHaveValue("")
    expect(screen.getByTestId("auto-compose-clarify-answer-1")).toHaveValue("")
  })

  it("reports edits with the question index", () => {
    const onAnswerChange = jest.fn()
    render(
      <AutoComposeClarifyStep
        questions={["Q1", "Q2"]}
        answers={["", ""]}
        onAnswerChange={onAnswerChange}
      />
    )
    fireEvent.change(screen.getByTestId("auto-compose-clarify-answer-1"), {
      target: { value: "devs" },
    })
    expect(onAnswerChange).toHaveBeenCalledWith(1, "devs")
  })
})
