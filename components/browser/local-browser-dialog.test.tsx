/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/ui/alert-dialog")

import { LocalBrowserDialog } from "./local-browser-dialog"

it("renders nothing without a dialog", () => {
  render(<LocalBrowserDialog dialog={null} onAnswer={jest.fn()} />)
  expect(screen.queryByTestId("local-browser-dialog")).toBeNull()
})

it("shows an alert with only an OK", () => {
  const onAnswer = jest.fn()
  render(<LocalBrowserDialog dialog={{ type: "alert", message: "Saved!" }} onAnswer={onAnswer} />)
  expect(screen.getByText("The page says")).toBeInTheDocument()
  expect(screen.getByText("Saved!")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "OK" }))
  expect(onAnswer).toHaveBeenCalledWith({ accept: true })
})

it("lets a confirm be dismissed", () => {
  const onAnswer = jest.fn()
  render(
    <LocalBrowserDialog dialog={{ type: "confirm", message: "Delete?" }} onAnswer={onAnswer} />
  )
  expect(screen.getByText("The page asks")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(onAnswer).toHaveBeenCalledWith({ accept: false })
})

it("answers a prompt with the typed text, seeded from its default", () => {
  const onAnswer = jest.fn()
  render(
    <LocalBrowserDialog
      dialog={{ type: "prompt", message: "Name?", defaultValue: "Ada" }}
      onAnswer={onAnswer}
    />
  )
  const input = screen.getByRole("textbox", { name: "Your answer" })
  expect(input).toHaveValue("Ada")
  fireEvent.change(input, { target: { value: "Grace" } })
  fireEvent.click(screen.getByRole("button", { name: "OK" }))
  expect(onAnswer).toHaveBeenCalledWith({ accept: true, promptText: "Grace" })
})

it("titles a leave-page dialog and an unknown type as an alert", () => {
  const { rerender } = render(
    <LocalBrowserDialog dialog={{ type: "beforeunload", message: "" }} onAnswer={jest.fn()} />
  )
  expect(screen.getByText("Leave this page?")).toBeInTheDocument()
  rerender(<LocalBrowserDialog dialog={{ type: "weird", message: "x" }} onAnswer={jest.fn()} />)
  expect(screen.getByText("The page says")).toBeInTheDocument()
})
