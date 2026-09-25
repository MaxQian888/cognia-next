import { fireEvent, render, screen } from "@testing-library/react"
import { ReadError } from "./read-error"

describe("ReadError", () => {
  it("inline: carries the backend message and retries", () => {
    const onRetry = jest.fn()
    render(<ReadError message="could not resolve host" onRetry={onRetry} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Could not load: could not resolve host")
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("block: fills its pane with a title, the message and a retry", () => {
    const onRetry = jest.fn()
    render(<ReadError variant="block" message="repository vanished" onRetry={onRetry} testId="x" />)
    expect(screen.getByTestId("x")).toHaveTextContent("Could not load")
    expect(screen.getByText("repository vanished")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("x-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
